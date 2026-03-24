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
    // We use a clean chess for finding all potential moves of a piece on a square
    // This replicates python-chess's move generation for empty boards
    const chess = new Chess();

    for (let rank = 0; rank < 8; rank++) {
      for (let file = 0; file < 8; file++) {
        const fromSq = FILES[file] + (rank + 1);
        
        // Queen moves (matches all_moves.extend(legal_moves) with Queen)
        chess.clear();
        chess.put({ type: 'q', color: 'w' }, fromSq);
        let moves = chess.moves({ verbose: true });
        moves.sort((a, b) => {
          const rA = parseInt(a.to[1]) - 1;
          const fA = a.to.charCodeAt(0) - 97;
          const rB = parseInt(b.to[1]) - 1;
          const fB = b.to.charCodeAt(0) - 97;
          return (rA * 8 + fA) - (rB * 8 + fB);
        });
        moves.forEach(m => table.push(m.from + m.to));

        // Knight moves (matches all_moves.extend(legal_moves) with Knight)
        chess.clear();
        chess.put({ type: 'n', color: 'w' }, fromSq);
        moves = chess.moves({ verbose: true });
        moves.sort((a, b) => {
          const rA = parseInt(a.to[1]) - 1;
          const fA = a.to.charCodeAt(0) - 97;
          const rB = parseInt(b.to[1]) - 1;
          const fB = b.to.charCodeAt(0) - 97;
          return (rA * 8 + fA) - (rB * 8 + fB);
        });
        moves.forEach(m => table.push(m.from + m.to));
      }
    }

    // Pawn Promotions (matches generate_pawn_promotions() in main.py)
    const promoPieces = ['q', 'r', 'b', 'n'];
    for (let fIdx = 0; fIdx < 8; fIdx++) {
      const f = FILES[fIdx];
      // Direct
      promoPieces.forEach(p => table.push(`${f}7${f}8${p}`));
      // Left capture
      if (fIdx > 0) {
        const lf = FILES[fIdx - 1];
        promoPieces.forEach(p => table.push(`${f}7${lf}8${p}`));
      }
      // Right capture
      if (fIdx < 7) {
        const rf = FILES[fIdx + 1];
        promoPieces.forEach(p => table.push(`${f}7${rf}8${p}`));
      }
    }
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
        const rank0 = 7 - r, file0 = f;
        const tensorIdx = rank0 * 8 + file0;
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
      tensor[17 * 64 + r_ep * 8 + f_ep] = 1.0;
    }
    return tensor;
  }

  // -------------------------------------------------------------------------
  // 3. Main Interface
  // -------------------------------------------------------------------------

  let session = null;
  let isMaia2 = false;

  async function loadModel(modelPath = './models/maia-1500.onnx') {
    try {
      session = await ort.InferenceSession.create(modelPath, {
        executionProviders: ['wasm'],
        graphOptimizationLevel: 'all',
      });
      // Detect model type by input names/count
      isMaia2 = session.inputNames.length > 1 || session.inputNames.includes('boards');
      console.log(`[Maia] Loaded ${isMaia2 ? 'Maia 2 / Rapid' : 'Maia 1 (Leela)'} model.`);
      return true;
    } catch (err) {
      console.error('[Maia] Failed to load model:', err);
      return false;
    }
  }

  async function getMaiaProbs(chess, eloSelf = 1500, eloOppo = 1500) {
    if (!session) throw new Error('Maia model not loaded.');

    const isBlack = chess.turn() === 'b';
    let outputMap;

    if (isMaia2) {
      const inputData = encodeMaia2(chess);
      const catSelf = mapEloToCategory(eloSelf);
      const catOppo = mapEloToCategory(eloOppo);
      outputMap = await session.run({
        'boards': new ort.Tensor('float32', inputData, [1, 18, 8, 8]),
        'elo_self': new ort.Tensor('int64', BigInt64Array.from([BigInt(catSelf)]), [1]),
        'elo_oppo': new ort.Tensor('int64', BigInt64Array.from([BigInt(catOppo)]), [1])
      });
    } else {
      const inputData = encodeLeela(chess);
      const inputTensor = new ort.Tensor('float32', inputData, [1, 112, 8, 8]);
      outputMap = await session.run({ [session.inputNames[0]]: inputTensor });
    }

    // Policy is usually the first output
    const policyKey = session.outputNames[0];
    const logits = outputMap[policyKey].data;

    // Apply Softmax
    const maxLogit = Math.max(...logits);
    const exps = Array.from(logits).map(x => Math.exp(x - maxLogit));
    const sumExp = exps.reduce((a, b) => a + b, 0);
    const probs = exps.map(x => x / sumExp);

    const legalMoves = chess.moves({ verbose: true });
    const legalUCISet = new Map();
    legalMoves.forEach(m => legalUCISet.set(m.from + m.to + (m.promotion || ''), m));

    const result = [];
    const policyTable = isMaia2 ? MAIA2_POLICY : LEELA_POLICY;

    for (let i = 0; i < policyTable.length; i++) {
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
    return result;
  }

  return { loadModel, getMaiaProbs };
})();

window.MAIA = MAIA;