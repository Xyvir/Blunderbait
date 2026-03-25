/**
 * main.js — Orchestration Entry Point
 * Wires chess.js + WorkerHelper + MAIA + BBI pipeline + UI together.
 */

(async function () {
  // Declare shared state FIRST — before UI.init() registers callbacks
  // (avoids Temporal Dead Zone errors if a move fires before await resolves)
  let modelLoaded = false;
  let pipelineRunning = false;
  let queuedFen = null;
  let currentFen = null;
  let currentPipelineId = 0;
  let isImporting = false;

  // -------------------------------------------------------------------------
  // Instantiate core objects
  // -------------------------------------------------------------------------
  const chess = new Chess();
  const workerHelper = new BBI.WorkerHelper();

  // Seeding of startpos.json removed to ensure evaluation sync and engine consistency.

  // -------------------------------------------------------------------------
  // Initialize chessboard UI
  // -------------------------------------------------------------------------
  UI.init(chess, triggerBBIPipeline);
  UI.updateStatus();

  // -------------------------------------------------------------------------
  // Load Maia model & Explorer DB
  // -------------------------------------------------------------------------
  const modelStatus = document.getElementById('model-status');
  modelStatus.textContent = 'Loading Engine & DB…';
  modelStatus.className = 'model-status loading';

  // Load DB first (it's large, start it early)
  const dbPromise = MAIA.loadExplorerDB('./models/explorer_db.json');
  
  await MAIA.loadModel('./models/maia_rapid.onnx').then(async ok => {
    modelLoaded = ok;
    const statusEl = document.getElementById('model-status');
    if (ok) {
      await dbPromise; // Ensure DB is also tried
      statusEl.textContent = 'Maia Rapid ✓';
      statusEl.className = 'model-status ok';
      if (queuedFen) {
        await triggerBBIPipeline(queuedFen, null);
        queuedFen = null;
      } else {
        // Auto-calculate the initial position on load
        await triggerBBIPipeline(chess.fen(), null);
      }
    } else {
      statusEl.textContent = 'Maia model not found — place maia_rapid.onnx in ./models/';
      statusEl.className = 'model-status error';
      UI.showToast('Maia model not found. Place maia_rapid.onnx in ./models/ and reload.', 'error');
    }

    // Hide initial fullscreen loader once everything is ready
    const loader = document.getElementById('app-loader');
    if (loader) {
      loader.classList.add('hidden');
      setTimeout(() => loader.remove(), 500); // cleanup from DOM
    }
  });

  // -------------------------------------------------------------------------
  // DOM event listeners
  // -------------------------------------------------------------------------
  document.getElementById('btn-flip').addEventListener('click', () => UI.flipBoard());
  document.getElementById('btn-reset').addEventListener('click', () => { UI.resetBoard(); UI.clearBlunderOverlay(); });
  document.getElementById('btn-undo').addEventListener('click', () => UI.undoMove());
  document.getElementById('btn-next').addEventListener('click', () => UI.nextMove());
  document.getElementById('btn-clear-cache').addEventListener('click', async () => {
    await BBI.Cache.clear();
    UI.resetBoard();
    UI.clearBlunderOverlay();
    UI.showToast('Memory wiped and returned to Start', 'success');
  });

  document.getElementById('btn-set-fen').addEventListener('click', () => {
    const fen = document.getElementById('fen-input').value.trim();
    UI.loadFEN(fen);
  });

  document.getElementById('fen-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('btn-set-fen').click();
  });

  // Depth slider
  const depthSlider = document.getElementById('depth-slider');
  const depthLabel = document.getElementById('depth-label');
  depthSlider.addEventListener('input', () => {
    depthLabel.textContent = depthSlider.value;
  });

  // SEE threshold slider
  const seeSlider = document.getElementById('see-slider');
  const seeLabel = document.getElementById('see-label');
  seeSlider.addEventListener('input', () => {
    seeLabel.textContent = (parseFloat(seeSlider.value) >= 0 ? '+' : '') + seeSlider.value;
  });

  // Player Perspective Mode toggle
  const oneSidedToggle = document.getElementById('toggle-onesided');
  if (oneSidedToggle) {
    const applyToggle = () => {
      const wrapper = document.querySelector('.board-wrapper');
      if (wrapper) wrapper.classList.toggle('one-sided', oneSidedToggle.checked);
    };
    oneSidedToggle.addEventListener('change', applyToggle);
    applyToggle();
  }

  // -------------------------------------------------------------------------
  // PGN Import & Game Review
  // -------------------------------------------------------------------------
  async function importPGN() {
    if (isImporting) {
      UI.showToast('Another import is already in progress.', 'warning');
      return;
    }

    const pgnEl = document.getElementById('pgn-input');
    const pgn = pgnEl.value.trim();
    if (!pgn) return;

    const tempChess = new Chess();
    if (!tempChess.load_pgn(pgn)) {
      UI.showToast('Invalid PGN format.', 'error');
      return;
    }

    isImporting = true;
    const history = tempChess.history({ verbose: true });
    
    // UI Progress Setup
    const progContainer = document.getElementById('pgn-progress-container');
    const progFill = document.getElementById('pgn-progress-fill');
    const progText = document.getElementById('pgn-progress-text');
    
    progContainer.classList.remove('hidden');
    progFill.style.width = '0%';
    progText.textContent = `0 / ${history.length + 1}`;

    try {
      // Reset board to the PGN's starting position
      const pgnHeader = tempChess.header();
      const startFen = pgnHeader.FEN || 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
      
      UI.showToast(`Hydrating ${history.length} moves...`, 'info');

      // UI.loadFEN updates visual board, global chess state, and triggers initial evaluation
      const ok = UI.loadFEN(startFen);
      if (!ok) throw new Error("Failed to load starting FEN");

      // Use a fresh chess instance to step through
      const walkChess = new Chess(startFen);
      
      progFill.style.width = `${(1 / (history.length + 1)) * 100}%`;
      progText.textContent = `1 / ${history.length + 1}`;

      // 2. Loop through moves
      for (let i = 0; i < history.length; i++) {
          if (!isImporting) break;

          const move = history[i];
          walkChess.move(move);
          
          // Hydrate silently
          await triggerBBIPipeline(walkChess.fen(), move, true, 9);
          
          // Update progress
          const currentCount = i + 2;
          const pct = (currentCount / (history.length + 1)) * 100;
          progFill.style.width = `${pct}%`;
          progText.textContent = `${currentCount} / ${history.length + 1}`;

          // Give the browser a moment to breathe/render
          await new Promise(r => setTimeout(r, 20));
      }

      UI.showToast('Game Review ready!', 'success');
    } catch (err) {
      console.error('[PGN Import] Crashed:', err);
      UI.showToast('Import interrupted by an error.', 'error');
    } finally {
      isImporting = false;
      setTimeout(() => progContainer.classList.add('hidden'), 5000);
    }
  }

  document.getElementById('btn-import-pgn').addEventListener('click', importPGN);

  // -------------------------------------------------------------------------
  // Pipeline orchestration
  // -------------------------------------------------------------------------
  // (pipelineRunning and queuedFen declared at top of IIFE)

  async function triggerBBIPipeline(fen, executedMove, silent = false, depthOverride = null) {
    const pipelineId = ++currentPipelineId;
    workerHelper.clear(); // Interrupt Stockfish

    if (!silent) {
      isImporting = false; // Abort any active PGN hydration on manual move
      UI.clearBestMoveArrow(); 
      UI.clearScorePanel();    
      UI.clearBlunderOverlay();
    }

    const prevFen = currentFen;
    currentFen = fen || chess.fen();

    if (!silent) document.getElementById('fen-input').value = currentFen;
    if (!modelLoaded) return;

    pipelineRunning = true;
    if (!silent) UI.showLoading(true, 'Evaluating position...', 0);

    try {
      const depth = depthOverride || parseInt(document.getElementById('depth-slider').value, 10);
      const seeThreshold = parseFloat(document.getElementById('see-slider').value);

      // Clone the board to isolate this pipeline run from future UI mutations (e.g. Undo, Next Move)
      const pipelineChess = new Chess(currentFen);

      const result = await BBI.runPipeline(pipelineChess, workerHelper, {
        seeThreshold, depth,
        onProgress: (pct) => {
          if (!silent && currentPipelineId === pipelineId) UI.updateProgress(pct);
        }
      });

      if (currentPipelineId !== pipelineId) return;

      // Retroactively add this position's grade to the previous move's cache!
      if (executedMove && prevFen) {
        const dScale = parseInt(document.getElementById('depth-slider').value, 10);
        const sScale = parseFloat(document.getElementById('see-slider').value);
        const prevKey = BBI.getCacheKey(prevFen, dScale, sScale);
        const prevCache = await BBI.Cache.get(prevKey);
        
        if (prevCache) {
          const uci = executedMove.from + executedMove.to + (executedMove.promotion || '');
          
          // 1. Track navigation
          prevCache.lastNavigatedUci = uci;

          // 2. Retroactive grading
          let mMatch = prevCache.moveTable.find(m => m.uci === uci);
          if (!mMatch) {
            mMatch = {
              uci: uci,
              san: executedMove.san,
              from: executedMove.from,
              to: executedMove.to,
              piece: executedMove.piece,
              color: executedMove.color,
              prob: 0,
              evalPawns: result.objectiveEval,
              cpLoss: 0,
            };
            prevCache.moveTable.push(mMatch);
          }
          mMatch.futureGrade = result.grade;
          
          await BBI.Cache.set(prevKey, prevCache);
        }
      }

      if (silent) return result; // Return early for background hydration

      UI.updateScorePanel(result);
      UI.updateMoveHeatmap(result.moveTable, result.source);
      UI.renderBlunderOverlay(result.moveTable, result.objectiveEval);
      UI.renderBestMoveArrow(result.bestmove);

      // Interpret the grade statefully for the side to move
      const side = chess.turn() === 'w' ? 'White' : 'Black';
      const interpEl = document.getElementById('delta-interp');

      if (result.grade === 'SS') {
        interpEl.innerHTML = `☠️ <strong>${side} is facing a lethal trap!</strong>`;
        interpEl.className = 'interp high';
      } else if (result.grade === 'S') {
        // Only call it a "forced move" if there are no other unpruned options
        const unpruned = result.moveTable.filter(m => !m.isPruned);
        if (unpruned.length === 1 && result.moveTable.length === 1) {
          interpEl.innerHTML = `🎯 <strong>${side} has a forced move — no alternative options</strong>`;
        } else if (unpruned.length === 1) {
          interpEl.innerHTML = `🎯 <strong>${side} has a strategic 'only move'</strong>`;
        } else {
          interpEl.innerHTML = `🔥 <strong>${side} is in severe danger</strong>`;
        }
        interpEl.className = 'interp high';
      } else if (result.grade === 'A') {
        interpEl.innerHTML = `⚠️ <strong>${side} is in a minefield</strong>`;
        interpEl.className = 'interp high';
      } else if (result.grade === 'B') {
        interpEl.innerHTML = `⚡ <strong>${side} is in a tense position</strong>`;
        interpEl.className = 'interp medium';
      } else if (result.grade === 'C') {
        interpEl.innerHTML = `🛡️ <strong>${side} is not likely to blunder</strong>`;
        interpEl.className = 'interp low';
      } else if (result.grade === 'D') {
        interpEl.innerHTML = `✅ <strong>${side} has plenty of safe options</strong>`;
        interpEl.className = 'interp neutral';
      } else if (result.grade === 'F') {
        const otherSide = chess.turn() === 'w' ? 'Black' : 'White';
        if (result.expectedEval >= 5.0) {
          interpEl.innerHTML = `🎉 <strong>${side} is starting or continuing a crushing attack</strong>`;
        } else if (result.expectedEval <= -5.0) {
          interpEl.innerHTML = `📉 <strong>${otherSide} is mounting a crushing attack against ${side}</strong>`;
        } else {
          interpEl.innerHTML = `🛡️ <strong>Stable — Human play is engine-aligned</strong>`;
        }
        interpEl.className = 'interp neutral';
      } else if (result.grade === '💀' || result.grade === '☠️') {
        interpEl.innerHTML = `💀 <strong>${side} has been checkmated</strong>`;
        interpEl.className = 'interp neutral';
      }

    } catch (e) {
      if (e.message !== 'Interrupted') console.error('Pipeline error:', e);
    } finally {
      if (currentPipelineId === pipelineId) {
        pipelineRunning = false;
        UI.showLoading(false);
      }
    }
  }

  window._bbidebug = { chess, workerHelper };
})();
