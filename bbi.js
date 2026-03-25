/**
 * bbi.js — Core BBI Calculation Pipeline
 *
 * Exports: runPipeline(chess, workerHelper, gradeOnly=false)
 * Returns: { objectiveEval, expectedEval, delta, grade, moveTable,fen }
 */

function gradeFromDelta(delta, objectiveEval, isForcedMate) {
  // If the active player has a forced mate in their favor, they're winning!
  // This isn't a trap for them—it means the *opponent* played a suicidal blunder.
  if (isForcedMate && objectiveEval > 0) return 'F'; 
 
  
  if (delta >= 9.0)  return 'S'; 
  if (delta >= 5.0)  return 'A'; 
  if (delta >= 3.0)  return 'B'; 
  if (delta >= 1.5)  return 'C'; 
  if (delta >= 0.0)  return 'D'; 
  return 'F';                    
}

// -------------------------------------------------------------------------
// Global Cache (Memory + IndexedDB)
// -------------------------------------------------------------------------
const BBICache = (() => {
  const DB_NAME = 'BBICacheDB';
  const STORE_NAME = 'evals';
  const VERSION = 1;
  let dbPromise = null;
  const memCache = new Map();

  // Pre-loading of starting position removed to ensure evaluation sync and engine consistency.

  function initDB() {
    if (!window.indexedDB) return Promise.reject('No IDB');
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, VERSION);
        req.onupgradeneeded = (e) => { e.target.result.createObjectStore(STORE_NAME); };
        req.onsuccess = (e) => resolve(e.target.result);
        req.onerror = () => reject('IndexedDB error');
      });
    }
    return dbPromise;
  }

  async function get(fen) {
    // Check IndexedDB first so we don't accidentally overwrite richer retroactively-graded data with hardcoded memCache
    try {
      const db = await initDB();
      return await new Promise(resolve => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const req = tx.objectStore(STORE_NAME).get(fen);
        req.onsuccess = () => {
          if (req.result) {
            memCache.set(fen, req.result);
            resolve(req.result);
          } else {
            resolve(memCache.get(fen) || null);
          }
        };
        req.onerror = () => resolve(memCache.get(fen) || null);
      });
    } catch { 
      return memCache.get(fen) || null; 
    }
  }

  async function set(fen, data) {
    memCache.set(fen, data);
    try {
      const db = await initDB();
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put(data, fen);
    } catch { /* ignore */ }
  }

  async function clear() {
    memCache.clear();
    try {
      const db = await initDB();
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).clear();
    } catch { /* ignore */ }
  }

  return { get, set, clear };
})();

// Convert Stockfish cp score to pawn units (capped ±30 for readability)
function cpToPawns(score_cp, score_mate, sideToMove) {
  // sideToMove: 'w' or 'b'. Stockfish always reports from side-to-move perspective.
  // We convert so that positive = good for the side to move in this position.
  if (score_mate != null) {
    // Forced mate: return a large signed value
    const sign = score_mate > 0 ? 1 : -1;
    return sign * 30; // treat as ±30 pawns
  }
  const pawns = (score_cp || 0) / 100;
  return Math.max(-30, Math.min(30, pawns));
}

// -------------------------------------------------------------------------
// WorkerHelper — drives stockfish.js via raw UCI string messages
// stockfish.js is used DIRECTLY as the Worker (its intended usage pattern).
// -------------------------------------------------------------------------
class WorkerHelper {
  constructor() {
    // Use stockfish.js as the worker source directly
    this.sf       = new Worker('./stockfish.js');
    this.pending  = [];       // queue of {resolve, score_cp, score_mate, pv}
    this.active   = null;     // currently running job
    this.ready    = false;

    this.sf.onmessage = (e) => this._handleLine(
      typeof e === 'string' ? e : (e.data ?? '')
    );
    this.sf.onerror = (e) => console.error('[Stockfish] Worker error:', e);

    // Init UCI
    this.sf.postMessage('uci');
    this.sf.postMessage('setoption name Hash value 32');
    this.sf.postMessage('isready');
  }

  _handleLine(line) {
    if (!line || typeof line !== 'string') return;

    if (line === 'readyok' && !this.ready) {
      this.ready = true;
      this._runNext();
      return;
    }

    const job = this.active;
    if (!job) return;

    if (line.startsWith('info') && line.includes('score')) {
      const cpM   = line.match(/score cp (-?\d+)/);
      const mateM = line.match(/score mate (-?\d+)/);
      const pvM   = line.match(/ pv (.+)/);
      if (cpM)   { job.score_cp = parseInt(cpM[1], 10); job.score_mate = null; }
      if (mateM) { job.score_mate = parseInt(mateM[1], 10); job.score_cp = null; }
      if (pvM)   job.pv = pvM[1].trim();
    }

    if (line.startsWith('bestmove')) {
      job.bestmove = line.split(' ')[1];
      this.active  = null;
      job.resolve({ score_cp: job.score_cp, score_mate: job.score_mate,
                    bestmove: job.bestmove, pv: job.pv || '' });
      this._runNext();
    }
  }

  _runNext() {
    if (this.active || !this.ready || this.pending.length === 0) return;
    this.active = this.pending.shift();
    this.active.start(this.sf);
  }

  _enqueue(fen, move, depth) {
    return new Promise((resolve) => {
      const job = {
        resolve, score_cp: null, score_mate: null, pv: '', bestmove: null,
        start(sf) {
          // REMOVED: sf.postMessage('ucinewgame'); — calling ucinewgame before every search destroys the Transposition Table (Hash) 
          // and causes massive instability in move evaluations at low depth.
          if (move) {
            sf.postMessage(`position fen ${fen} moves ${move}`);
          } else {
            sf.postMessage(`position fen ${fen}`);
          }
          sf.postMessage(`go depth ${depth}`);
        },
      };
      this.pending.push(job);
      this._runNext();
    });
  }

  eval(fen, depth = 12)            { return this._enqueue(fen, null,  depth); }
  evalMove(fen, move, depth = 12)  { return this._enqueue(fen, move,  depth); }

  clear() {
    if (this.active) this.active.resolve(null);
    for (const job of this.pending) job.resolve(null);
    this.pending = [];
    this.active = null;
    if (this.sf) this.sf.postMessage('stop');
  }
}


// -------------------------------------------------------------------------
// Main Pipeline
// -------------------------------------------------------------------------
async function runPipeline(chess, workerHelper, options = {}) {
  const {
    seeThreshold = -2.0,
    depth        = 12,
    maxMoves     = 20,   // cap plausible moves to evaluate for speed
    onProgress   = null, // callback for progress bar
  } = options;

  const fen      = chess.fen();
  const turn     = chess.turn();

  // Check cache first (Key now includes depth, threshold, and logic revision)
  const cacheKey = getCacheKey(fen, depth, seeThreshold);
  const cached = await BBICache.get(cacheKey);
  if (cached) {
    console.log('[BBI] Loaded from cache:', cacheKey);
    if (onProgress) onProgress(1); // 100%
    return cached;
  }

  const isWhiteTurn = turn === 'w';

  // Short-circuit on game over
  if (chess.game_over()) {
    const isCheckmate = chess.in_checkmate();
    const terminalEval = isCheckmate ? (isWhiteTurn ? -10.0 : 10.0) : 0.0;
    if (onProgress) onProgress(1);
    
    // skull emojis for white vs black checkmated
    const skull = isWhiteTurn ? '☠️' : '💀'; 

    return {
      fen,
      objectiveEval: terminalEval,
      expectedEval: terminalEval,
      delta: 0.0,
      grade: isCheckmate ? skull : 'D',
      isForcedMate: isCheckmate,
      bestmove: null,
      moveTable: []
    };
  }

  // --- Step 1: Get Maia probabilities ---
  let rawProbs;
  let winProb = 0.5;
  let source = 'Maia';
  try {
    const maiaRes = await MAIA.getMaiaProbs(chess);
    rawProbs = maiaRes.moveProbs;
    winProb = maiaRes.winProb;
    source = maiaRes.source;
  } catch (err) {
    console.error('[BBI] Maia error:', err);
    // Fallback: uniform distribution over legal moves
    const moves = chess.moves({ verbose: true });
    const prob  = 1 / moves.length;
    rawProbs = moves.map(m => ({ move: m, uci: m.from + m.to + (m.promotion || ''), prob }));
    source = 'Fallback (Uniform)';
  }

  console.log(`[BBI] Sourced from ${source}: ${rawProbs.length} moves. WinProb: ${(winProb * 100).toFixed(1)}%`);
  
  // Store original top probability and move for hydration formula
  const topProbPair = rawProbs.length > 0 ? rawProbs[0] : null;
  const maiaTopProb = topProbPair ? topProbPair.prob : 0;
  const maiaTopUCI = topProbPair ? topProbPair.uci : null;
  console.log(`[BBI] Maia Top Move: ${maiaTopUCI} (${(maiaTopProb * 100).toFixed(1)}%)`);

  // --- Step 2: SEE Plausibility Filter ---
  const probThreshold = 0.005; // Moved up to avoid ReferenceError
  let plausible = SEE.filterByPlausibility(chess, rawProbs, seeThreshold);
  
  // --- Step 2.1: Identify Hydration Candidates (+2.5 SEE) ---
  const hydrationCandidates = SEE.scanForHydration(chess, 2.5);
  console.log(`[BBI] SEE Hydration Scan found ${hydrationCandidates.length} candidate moves.`);
  hydrationCandidates.forEach(m => {
    const uci = m.from + m.to + (m.promotion || '');
    const existing = plausible.find(p => p.uci === uci);
    if (existing) {
      existing.isHydrationCandidate = true;
    } else {
      const original = rawProbs.find(p => p.uci === uci);
      const prob = original ? original.prob : 0;
      plausible.push({ 
        move: m, 
        uci, 
        prob, 
        see: SEE.computeSEE(chess, m), 
        isHydrationCandidate: true 
      });
    }
  });

  // Calculate maiaTopProb AFTER SEE filtering/re-normalization to ensure strong hydration
  // We use the top move from the 'significant' set if available
  const topSignificant = plausible.filter(p => p.prob > probThreshold).sort((a, b) => b.prob - a.prob)[0];
  const effectiveMaiaTopProb = topSignificant ? topSignificant.prob : maiaTopProb;
  console.log(`[BBI] Effective Maia Top Prob for Hydration: ${(effectiveMaiaTopProb * 100).toFixed(1)}%`);

  console.log(`[SEE] ${plausible.length} moves survived (threshold: ${seeThreshold})`);

  // --- Step 2.5: Human Probability Pruning ---
  // Mark moves with <= 0.5% probability as pruned. They will be visible in the UI but excluded from BBI score calculations.
  const significant = plausible.filter(p => p.prob > probThreshold);
  const totalSignificantProb = significant.reduce((sum, p) => sum + p.prob, 0);
  
  if (significant.length > 0 && significant.length < plausible.length) {
    plausible = plausible.map(p => {
      const isPruned = p.prob <= probThreshold;
      return {
        ...p,
        isPruned,
        // bbiProb is the re-normalized probability among non-pruned moves (used for expectedEval)
        bbiProb: isPruned ? 0 : (p.prob / totalSignificantProb)
      };
    });
  } else {
    // Fallback: If ALL moves are low-prob, or if ALL moves are above threshold, don't prune anything.
    plausible = plausible.map(p => ({ ...p, isPruned: false, bbiProb: p.prob }));
  }

  // --- Step 3 & 4 Progress tracking ---
  let movesToEval = plausible.slice(0, maxMoves);
  
  // Ensure all hydration candidates are included in the evaluation
  plausible.filter(p => p.isHydrationCandidate).forEach(c => {
    if (!movesToEval.some(m => m.uci === c.uci)) {
      movesToEval.push(c);
    }
  });

  const totalTasks = movesToEval.length + 1; // +1 for the objective eval
  let completedTasks = 0;
  const tickProgress = () => {
    completedTasks++;
    if (onProgress) onProgress(completedTasks / totalTasks);
  };

  // --- Step 3: Objective Evaluation of current position ---
  const objResult = await workerHelper.eval(fen, depth);
  if (!objResult) throw new Error('Interrupted');

  tickProgress();
  let objectiveEval = cpToPawns(objResult.score_cp, objResult.score_mate, turn);
  const isForcedMate = objResult.score_mate != null;

  // --- Step 4: Evaluate each plausible move via Stockfish ---
  const evalPromises = movesToEval.map(pair => {
    const testChess = new Chess(fen);
    testChess.move(pair.uci, { sloppy: true });

    if (testChess.game_over()) {
      tickProgress();
      const isCheckmate = testChess.in_checkmate();
      const objMateLimit = isWhiteTurn ? 10.0 : -10.0;
      return Promise.resolve({
        ...pair,
        score_cp: 0,
        score_mate: isCheckmate ? 0 : null,
        evalPawns: isCheckmate ? objMateLimit : 0.0
      });
    }

    return workerHelper.evalMove(fen, pair.uci, depth).then(res => {
      if (!res) throw new Error('Interrupted');
      tickProgress();
      return {
        ...pair,
        score_cp:   res.score_cp,
        score_mate: res.score_mate,
        // After opponent's response position, we negate (it's opponent's turn next)
        evalPawns:  -cpToPawns(res.score_cp, res.score_mate, turn === 'w' ? 'b' : 'w'),
        bbiProb:    pair.bbiProb,
        isPruned:   pair.isPruned,
      };
    });
  });

  const evaluated = await Promise.all(evalPromises);
  console.log(`[BBI] Evaluated ${evaluated.length} moves with Stockfish`);

  // --- Step 4.5: Re-sync Objective Evaluation ---
  // If individualized move searches found a better result than the root search, use that as the baseline.
  // This ensures the dashboard doesn't contradict the move list.
  const bestMoveVal = evaluated.length > 0 ? evaluated.reduce((max, e) => (e.evalPawns > max ? e.evalPawns : max), -30.0) : objectiveEval;
  const syncedObjectiveEval = (Math.abs(bestMoveVal - objectiveEval) > 0.05) ? bestMoveVal : objectiveEval;

  // --- Step 4.7: SEE Hydration Implementation ---
  // Compare high-SEE moves against Maia's preferred choice (original top probability move)
  const maiaBestMove = evaluated.find(e => e.uci === maiaTopUCI);
  const maiaBestEval = maiaBestMove ? maiaBestMove.evalPawns : objectiveEval;

  let hydrationApplied = false;
  let finalEvaluatedList = evaluated.map(e => {
    if (e.isHydrationCandidate && e.evalPawns > (maiaBestEval + 0.1)) {
      // Use effectiveMaiaTopProb for a much stronger hydration effect
      const boost = (e.evalPawns - maiaBestEval) * effectiveMaiaTopProb;
      if (boost > 0) {
        hydrationApplied = true;
        console.log(`[BBI] Hydrating move ${e.uci}: eval=${e.evalPawns.toFixed(2)} vs maiaBest=${maiaBestEval.toFixed(2)}, boost=${boost.toFixed(4)}`);
        return { ...e, prob: e.prob + boost, isHydrated: true, hydrationBoost: boost };
      }
    }
    return e;
  });

  if (hydrationApplied) {
    const totalProb = finalEvaluatedList.reduce((sum, e) => sum + e.prob, 0);
    finalEvaluatedList = finalEvaluatedList.map(e => ({ ...e, prob: e.prob / totalProb }));
    
    // Re-calculate bbiProb/isPruned for expectedEval based on hydrated probabilities
    const sig = finalEvaluatedList.filter(e => e.prob > probThreshold);
    const totalSigProb = sig.reduce((sum, e) => sum + e.prob, 0);
    finalEvaluatedList = finalEvaluatedList.map(e => {
      const isPruned = e.prob <= probThreshold;
      return {
        ...e,
        isPruned,
        bbiProb: isPruned ? 0 : (e.prob / totalSigProb)
      };
    });
    console.log(`[BBI] SEE Hydration successfully applied.`);
  }

  const finalEvaluated = finalEvaluatedList;

  // --- Step 5: Expected Evaluation ---
  // Expected Eval only considers 'significant' moves (> 0.5% prob after hydration/re-normalization)
  const expectedEval = finalEvaluated.reduce((sum, e) => sum + e.bbiProb * e.evalPawns, 0);

  // --- Step 6: BBI Delta ---
  const delta = syncedObjectiveEval - expectedEval;

  // --- Step 7: Grade ---
  // Check if humans have >= 1% chance of blundering into a forced mate (eval drops to -30)
  const hasHumanFindableMate = finalEvaluated.some(e => e.prob > 0.01 && e.evalPawns <= -20.0);
  const isLethalTrap = delta >= 4.0 && hasHumanFindableMate;
  
  // Find the most likely Maia move to see if we possess a crushing lead
  const topHumanMove = finalEvaluated.length > 0 ? finalEvaluated.reduce((prev, curr) => (curr.prob > prev.prob ? curr : prev)) : null;
  const topHumanEval = topHumanMove ? topHumanMove.evalPawns : objectiveEval;

  let grade = isLethalTrap ? 'SS' : gradeFromDelta(delta, objectiveEval, isForcedMate);
  
  // Extension: F-rank also covers cases where the outcome is already a crushing lead (+5 margin)
  // regardless of how much was "lost" compared to the engine best.
  if (expectedEval >= 5.0 || expectedEval <= -5.0) {
    grade = 'F';
  }
  
  // Forced move edge case: If there's only one legal move, the human cannot blunder.
  // We award an S rank because the correct move is "found" by default.
  if (finalEvaluated.length === 1) {
    grade = 'S';
  }

  if (isForcedMate && objectiveEval > 0) grade = 'F'; 
  else if (isLethalTrap) grade = 'SS';

  // Sort by probability DESC so hydrated moves rise to the top
  finalEvaluated.sort((a, b) => b.prob - a.prob);

  // Build move table for display
  const moveTable = finalEvaluated.map(e => ({
    uci:       e.uci,
    san:       e.move.san,
    from:      e.move.from,
    to:        e.move.to,
    piece:     e.move.piece,      // 'p','n','b','r','q','k'
    color:     e.move.color,      // 'w' or 'b'
    prob:      e.prob,
    see:       e.see,
    evalPawns: e.evalPawns,
    evalAbs:   isWhiteTurn ? e.evalPawns : -e.evalPawns, // White-relative for consistent dashboard display
    scoreMate: e.score_mate,
    weighted:  e.bbiProb * e.evalPawns,
    cpLoss:    Math.max(0, syncedObjectiveEval - e.evalPawns), // pawn units lost vs best play
    isPruned:  e.isPruned,
    isHydrated: e.isHydrated || false,
    isHydrationCandidate: e.isHydrationCandidate || false,
    hydrationBoost: e.hydrationBoost || 0,
  }));

  const finalResult = { objectiveEval: syncedObjectiveEval, expectedEval, delta, grade, moveTable, fen, isForcedMate, scoreMate: objResult.score_mate, bestmove: objResult.bestmove, source };
  
  // Save to cache
  await BBICache.set(cacheKey, finalResult);

  return finalResult;
}

const BBI_REVISION = '2026-03-24-v3'; // Increment to invalidate old logic/grading caches
function getCacheKey(fen, depth, seeThreshold) {
  return `${fen}|d${depth}|s${seeThreshold}|${BBI_REVISION}`;
}

window.BBI = { runPipeline, gradeFromDelta, cpToPawns, WorkerHelper, getCacheKey, Cache: BBICache };
