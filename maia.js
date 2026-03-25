/**
 * maia.js — Maia ONNX Inference Helper
 *
 * Supports both:
 * 1. Maia 1 (Lc0 style): 112 planes, [1, 1858] policy output.
 * 2. Maia 2 / Rapid: 18 planes, [1, 1968] policy output, 3 inputs (boards, elo_self, elo_oppo).
 */

const MAIA = (() => {
  // -------------------------------------------------------------------------
  // 1. Policy Tables
  // -------------------------------------------------------------------------

  function buildLeelaPolicyTable() {
    const table = [];
    const queenDirs = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
    const knightDirs = [[2, -1], [2, 1], [1, 2], [-1, 2], [-2, 1], [-2, -1], [-1, -2], [1, -2]];
    const promoDirs = [[1, -1], [1, 0], [1, 1]];
    const promoPieces = ['n', 'b', 'r'];

    for (let fromSq = 0; fromSq < 64; fromSq++) {
      const r1 = Math.floor(fromSq / 8);
      const c1 = fromSq % 8;
      for (const [dr, dc] of queenDirs) {
        for (let dist = 1; dist <= 7; dist++) {
          const r2 = r1 + dr * dist;
          const c2 = c1 + dc * dist;
          if (r2 >= 0 && r2 < 8 && c2 >= 0 && c2 < 8) table.push({ fromSq, toSq: r2 * 8 + c2, promo: null });
        }
      }
      for (const [dr, dc] of knightDirs) {
        const r2 = r1 + dr;
        const c2 = c1 + dc;
        if (r2 >= 0 && r2 < 8 && c2 >= 0 && c2 < 8) table.push({ fromSq, toSq: r2 * 8 + c2, promo: null });
      }
      if (r1 === 6) {
        for (const piece of promoPieces) {
          for (const [dr, dc] of promoDirs) {
            const r2 = r1 + dr;
            const c2 = c1 + dc;
            if (r2 === 7 && c2 >= 0 && c2 < 8) table.push({ fromSq, toSq: r2 * 8 + c2, promo: piece });
          }
        }
      }
    }
    return table;
  }

  function buildMaia2PolicyTable() {
    const table = [];
    const FILES = 'abcdefgh';

    // Loop through all squares in Rank-Major order (A1, B1... A2, B2...)
    for (let rank = 0; rank < 8; rank++) {
      for (let file = 0; file < 8; file++) {
        const fromSq = FILES[file] + (rank + 1);
        
        // 1. Queen moves
        const qTargets = [];
        const qDirs = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
        for (const [dr, dc] of qDirs) {
          for (let dist = 1; dist < 8; dist++) {
            const nr = rank + dr * dist;
            const nf = file + dc * dist;
            if (nr >= 0 && nr < 8 && nf >= 0 && nf < 8) {
              qTargets.push(nr * 8 + nf);
            } else break;
          }
        }
        qTargets.sort((a, b) => a - b);
        qTargets.forEach(tIdx => {
          const tr = Math.floor(tIdx / 8), tf = tIdx % 8;
          table.push(fromSq + FILES[tf] + (tr + 1));
        });

        // 2. Knight moves
        const kTargets = [];
        const kDirs = [[2,1],[2,-1],[-2,1],[-2,-1],[1,2],[1,-2],[-1,2],[-1,-2]];
        for (const [dr, dc] of kDirs) {
          const nr = rank + dr, nf = file + dc;
          if (nr >= 0 && nr < 8 && nf >= 0 && nf < 8) {
            kTargets.push(nr * 8 + nf);
          }
        }
        kTargets.sort((a, b) => a - b);
        kTargets.forEach(tIdx => {
          const tr = Math.floor(tIdx / 8), tf = tIdx % 8;
          table.push(fromSq + FILES[tf] + (tr + 1));
        });
      }
    }

    // 3. Pawn Promotions (Fixed list of 96)
    const promoPieces = ['q', 'r', 'b', 'n'];
    for (let fIdx = 0; fIdx < 8; fIdx++) {
      const f = FILES[fIdx];
      // Direct
      promoPieces.forEach(p => table.push(`${f}7${f}8${p}`));
      // Left
      if (fIdx > 0) {
        const lf = FILES[fIdx - 1];
        promoPieces.forEach(p => table.push(`${f}7${lf}8${p}`));
      }
      // Right
      if (fIdx < 7) {
        const rf = FILES[fIdx + 1];
        promoPieces.forEach(p => table.push(`${f}7${rf}8${p}`));
      }
    }
    console.log(`[Maia] Built Maia 2 policy table with ${table.length} moves.`);
    return table;
  }

  const LEELA_POLICY = buildLeelaPolicyTable();
  const MAIA2_POLICY = buildMaia2PolicyTable();

  // -------------------------------------------------------------------------
  // 2. Encoding Helpers
  // -------------------------------------------------------------------------

  function mirrorFEN(fen) {
    const parts = fen.split(' ');
    const rows = parts[0].split('/');
    const mirroredRows = rows.reverse().map(row => {
      return row.split('').map(c => {
        if (c >= 'a' && c <= 'z') return c.toUpperCase();
        if (c >= 'A' && c <= 'Z') return c.toLowerCase();
        return c;
      }).join('');
    });
    parts[0] = mirroredRows.join('/');
    parts[1] = (parts[1] === 'w') ? 'b' : 'w';
    let castling = parts[2];
    let newCastling = '';
    if (castling.includes('k')) newCastling += 'K';
    if (castling.includes('q')) newCastling += 'Q';
    if (castling.includes('K')) newCastling += 'k';
    if (castling.includes('Q')) newCastling += 'q';
    parts[2] = newCastling || '-';
    if (parts[3] && parts[3] !== '-') {
      const file = parts[3][0];
      const rank = parseInt(parts[3][1]);
      parts[3] = file + (9 - rank);
    }
    return parts.join(' ');
  }

  function mirrorMove(uci) {
    const mirrorSq = sq => sq[0] + (9 - parseInt(sq[1]));
    return mirrorSq(uci.slice(0, 2)) + mirrorSq(uci.slice(2, 4)) + uci.slice(4);
  }

  function mapEloToCategory(elo) {
    const start = 1100, end = 2000, interval = 100;
    if (elo < start) return 0;
    if (elo >= end) return 10;
    return Math.floor((elo - start) / interval) + 1;
  }

  function encodeLeela(chess) {
    const isBlack = chess.turn() === 'b';
    const us = chess.turn();
    const tensor = new Float32Array(112 * 64);
    const board = chess.board();
    const PIECE_ORDER = ['p', 'n', 'b', 'r', 'q', 'k'];

    for (let r = 0; r < 8; r++) {
      for (let f = 0; f < 8; f++) {
        const cell = board[r][f];
        if (!cell) continue;
        const actualRank0 = 7 - r;
        const leelaRank = isBlack ? (7 - actualRank0) : actualRank0;
        const leelaFile = isBlack ? (7 - f) : f;
        const y = 7 - leelaRank, x = leelaFile;
        const tensorIdx = y * 8 + x;
        const pieceIdx = PIECE_ORDER.indexOf(cell.type);
        const plane = (cell.color === us) ? pieceIdx : (6 + pieceIdx);
        tensor[plane * 64 + tensorIdx] = 1.0;
      }
    }
    if (isBlack) for (let i = 0; i < 64; i++) tensor[104 * 64 + i] = 1.0;
    const fenParts = chess.fen().split(' ');
    const moveCount = parseInt(fenParts[5] || '1', 10);
    const halfmove = parseInt(fenParts[4] || '0', 10);
    const castling = fenParts[2] || '-';
    const moveNorm = Math.min(moveCount / 511, 1);
    for (let i = 0; i < 64; i++) tensor[105 * 64 + i] = moveNorm;
    const wK = castling.includes('K') ? 1 : 0, wQ = castling.includes('Q') ? 1 : 0;
    const bK = castling.includes('k') ? 1 : 0, bQ = castling.includes('q') ? 1 : 0;
    const castleValues = isBlack ? [bK, bQ, wK, wQ] : [wK, wQ, bK, bQ];
    for (let p = 0; p < 4; p++) if (castleValues[p]) for (let i = 0; i < 64; i++) tensor[(106 + p) * 64 + i] = 1.0;
    const halfNorm = Math.min(halfmove / 99, 1);
    for (let i = 0; i < 64; i++) tensor[110 * 64 + i] = halfNorm;
    if (fenParts[3] && fenParts[3] !== '-') {
      const epF = fenParts[3].charCodeAt(0) - 97, epR = parseInt(fenParts[3][1], 10) - 1;
      const lEpR = isBlack ? (7 - epR) : epR, lEpF = isBlack ? (7 - epF) : epF;
      tensor[111 * 64 + (7 - lEpR) * 8 + lEpF] = 1.0;
    }
    return tensor;
  }

  function encodeMaia2(chess) {
    const isBlack = chess.turn() === 'b';
    const tensor = new Float32Array(18 * 64);
    let boardToEncode = chess;
    if (isBlack) {
      boardToEncode = new Chess();
      boardToEncode.load(mirrorFEN(chess.fen()));
    }
    const board = boardToEncode.board();
    const pieceMap = { 'p': 0, 'n': 1, 'b': 2, 'r': 3, 'q': 4, 'k': 5 };

    for (let r = 0; r < 8; r++) {
      for (let f = 0; f < 8; f++) {
        const cell = board[r][f];
        if (!cell) continue;
        // chess.js board[r][f] where r=0 is Rank 8.
        // Maia 2 ONNX expects Rank 1 at row 0, Rank 8 at row 7.
        // So we map r=0 (Rank 8) to row 7, and r=7 (Rank 1) to row 0.
        const row = 7 - r;
        const col = f;
        const tensorIdx = row * 8 + col;
        const plane = (cell.color === 'w' ? 0 : 6) + pieceMap[cell.type];
        tensor[plane * 64 + tensorIdx] = 1.0;
      }
    }
    for (let i = 0; i < 64; i++) tensor[12 * 64 + i] = 1.0; // Active side always W after mirror
    const fen = boardToEncode.fen().split(' ');
    const castling = fen[2];
    if (castling.includes('K')) for (let i = 0; i < 64; i++) tensor[13 * 64 + i] = 1.0;
    if (castling.includes('Q')) for (let i = 0; i < 64; i++) tensor[14 * 64 + i] = 1.0;
    if (castling.includes('k')) for (let i = 0; i < 64; i++) tensor[15 * 64 + i] = 1.0;
    if (castling.includes('q')) for (let i = 0; i < 64; i++) tensor[16 * 64 + i] = 1.0;
    const ep = fen[3];
    if (ep && ep !== '-') {
      const f_ep = ep.charCodeAt(0) - 97, r_ep = parseInt(ep[1]) - 1;
      // r_ep is already 0-7 where 0 is Rank 1.
      tensor[17 * 64 + r_ep * 8 + f_ep] = 1.0;
    }
    return tensor;
  }

  // -------------------------------------------------------------------------
  // 3. Main Interface
  // -------------------------------------------------------------------------

  let session = null;
  let isMaia2 = false;
  let explorerDB = null;
  let dbLoaded = false;

  async function loadExplorerDB(path = './models/explorer_db.json') {
    try {
      console.log(`[Maia] Loading Explorer DB from ${path}...`);
      const response = await fetch(path);
      if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
      explorerDB = await response.json();
      dbLoaded = true;
      console.log(`[Maia] Explorer DB loaded with ${Object.keys(explorerDB).length} positions.`);
      return true;
    } catch (err) {
      console.error('[Maia] Failed to load Explorer DB:', err);
      return false;
    }
  }

  async function loadModel(modelPath = './models/maia_rapid.onnx') {
    try {
      session = await ort.InferenceSession.create(modelPath, {
        executionProviders: ['wasm'],
        graphOptimizationLevel: 'all',
      });
      // Detect model type by input names/count
      isMaia2 = session.inputNames.length > 1 || session.inputNames.includes('boards');
      
      console.log(`[Maia] Loaded ${isMaia2 ? 'Maia 2 / Rapid' : 'Maia 1 (Leela)'} model.`);
      console.log('[Maia] Outputs:', session.outputNames);
      
      return true;
    } catch (err) {
      console.error('[Maia] Failed to load model:', err);
      return false;
    }
  }
  async function getMaiaProbs(chess, eloSelf = 1500, eloOppo = 1500) {
    if (!session) throw new Error('Maia model not loaded.');

    const isBlack = chess.turn() === 'b';

    // 1. Try Explorer DB (Opening Book)
    if (dbLoaded && explorerDB) {
      const fenParts = chess.fen().split(' ');
      const candidates = [
        fenParts.slice(0, 4).join(' '), // board turn castling ep
        fenParts.slice(0, 3).join(' '), // board turn castling
        fenParts.slice(0, 2).join(' ')  // board turn
      ];
      
      let dbEntry = null;
      for (const c of candidates) {
        if (explorerDB[c]) {
          dbEntry = explorerDB[c];
          break;
        }
      }

      if (dbEntry) {
        const moves = Object.keys(dbEntry);
        const totalCount = moves.reduce((sum, m) => sum + (dbEntry[m].count || 0), 0);
        
        if (totalCount > 0) {
          const dbMoveProbs = [];
          const tempChess = new Chess(chess.fen());
          
          for (const san of moves) {
            const m = tempChess.move(san);
            if (m) {
              const uci = m.from + m.to + (m.promotion || '');
              const prob = (dbEntry[san].count || 0) / totalCount;
              dbMoveProbs.push({ move: m, uci, prob });
              tempChess.undo();
            }
          }
          
          if (dbMoveProbs.length > 1) {
            console.log(`[Maia] Multi-move position in Lumbra's Opening Book. Sourcing ${dbMoveProbs.length} moves.`);
            return { moveProbs: dbMoveProbs, winProb: 0.5, source: "Lumbra's Opening Book" };
          } else if (dbMoveProbs.length === 1) {
            console.log(`[Maia] Single-move position in Lumbra's Opening Book. Merging with Maia model for alternates.`);
            const maiaRes = await getModelProbs(chess, eloSelf, eloOppo);
            const dbMove = dbMoveProbs[0];
            
            // Re-normalize model probs to sum to 0.1, DB move gets 0.9
            const modelMoveProbs = maiaRes.moveProbs.map(m => ({
              ...m,
              prob: m.uci === dbMove.uci ? (0.9 + m.prob * 0.1) : (m.prob * 0.1)
            }));
            
            modelMoveProbs.sort((a, b) => b.prob - a.prob);
            return { moveProbs: modelMoveProbs, winProb: maiaRes.winProb, source: 'Hybrid' };
          }
        }
      }
    }

    return getModelProbs(chess, eloSelf, eloOppo);
  }

  async function getModelProbs(chess, eloSelf, eloOppo) {
    const isBlack = chess.turn() === 'b';
    let outputMap;

    if (isMaia2) {
      const inputData = encodeMaia2(chess);
      const catSelf = mapEloToCategory(eloSelf);
      const catOppo = mapEloToCategory(eloOppo);
      
      const selfTensor = new ort.Tensor('int64', BigInt64Array.from([BigInt(catSelf)]), [1]);
      const oppoTensor = new ort.Tensor('int64', BigInt64Array.from([BigInt(catOppo)]), [1]);
      const boardsTensor = new ort.Tensor('float32', inputData, [1, 18, 8, 8]);

      outputMap = await session.run({
        'boards': boardsTensor,
        'elo_self': selfTensor,
        'elo_oppo': oppoTensor
      });
    } else {
      const inputData = encodeLeela(chess);
      const inputTensor = new ort.Tensor('float32', inputData, [1, 112, 8, 8]);
      outputMap = await session.run({ [session.inputNames[0]]: inputTensor });
    }


    // Policy is usually the first output (index 0)
    const policyKey = session.outputNames[0];
    const logits = outputMap[policyKey].data;

    // Win Probability / Value is usually the third output (index 2)
    let winProb = 0.5;
    if (isMaia2 && session.outputNames.length >= 3) {
      const valueKey = session.outputNames[2];
      const valLogit = outputMap[valueKey].data[0];
      // Clamp to [0, 1] following main.py: win_prob = (logits_value / 2 + 0.5).clamp(0, 1)
      winProb = Math.max(0, Math.min(1, valLogit / 2 + 0.5));
      if (isBlack) winProb = 1 - winProb;
    }

    const policyTable = isMaia2 ? MAIA2_POLICY : LEELA_POLICY;
    if (logits.length !== policyTable.length) {
      console.warn(`[Maia] Dimension mismatch! Model output: ${logits.length}, Policy table: ${policyTable.length}`);
    }

    // Apply Softmax
    const maxLogit = Math.max(...logits);
    const exps = Array.from(logits).map(x => Math.exp(x - maxLogit));
    const sumExp = exps.reduce((a, b) => a + b, 0);
    const probs = exps.map(x => x / sumExp);

    const legalMoves = chess.moves({ verbose: true });
    const legalUCISet = new Map();
    legalMoves.forEach(m => legalUCISet.set(m.from + m.to + (m.promotion || ''), m));

    const result = [];
    for (let i = 0; i < Math.min(policyTable.length, logits.length); i++) {
      let uci;
      if (isMaia2) {
        uci = policyTable[i];
        if (isBlack) uci = mirrorMove(uci);
      } else {
        const entry = policyTable[i];
        const leelaSqToAlg = (sq, black) => {
          const lr = Math.floor(sq / 8), lf = sq % 8;
          const r = black ? (7 - lr) : lr, f = black ? (7 - lf) : lf;
          return 'abcdefgh'[f] + (r + 1);
        };
        uci = leelaSqToAlg(entry.fromSq, isBlack) + leelaSqToAlg(entry.toSq, isBlack) + (entry.promo || '');
      }

      if (legalUCISet.has(uci)) {
        result.push({ move: legalUCISet.get(uci), uci, prob: probs[i] });
      }
    }

    // Fallback for moves not in policy table (e.g. edge cases)
    if (result.length < legalMoves.length) {
      const covered = new Set(result.map(r => r.uci));
      for (const [uci, m] of legalUCISet.entries()) {
        if (!covered.has(uci)) result.push({ move: m, uci, prob: 1e-5 });
      }
    }

    result.sort((a, b) => b.prob - a.prob);
    return { moveProbs: result, winProb, source: isMaia2 ? 'Maia Rapid' : 'Maia 1' };
  }

  return { loadModel, loadExplorerDB, getMaiaProbs };
})();

window.MAIA = MAIA;