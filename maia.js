/**
 * maia.js — Maia ONNX Inference Helper
 *
 * Loads a Maia chess model (lc0-format ONNX) and returns human move
 * probabilities for a given chess.js position.
 *
 * Input tensor: [1, 112, 8, 8] float32 — standard Leela encoding
 * Output: policy head [1, 1858] (move probabilities, softmax not applied by model)
 *
 * Model file: ./models/maia-1500.onnx  (place it there before running)
 */

const MAIA = (() => {
  // -------------------------------------------------------------------------
  // Leela policy index → {fromSq, toSq, promo}  (1858 entries)
  // All squares in "current player's perspective" space:
  //   sq = leela_rank * 8 + leela_file
  //   leela_rank 0 = current player's back rank
  //   files 0–7 = a–h (files are NOT mirrored)
  // -------------------------------------------------------------------------
  const QUEEN_DIRS   = [[1,0],[1,1],[0,1],[-1,1],[-1,0],[-1,-1],[0,-1],[1,-1]];
  const KNIGHT_DELTAS = [[2,1],[1,2],[-1,2],[-2,1],[-2,-1],[-1,-2],[1,-2],[2,-1]];
  const UNDER_PROMOS  = ['n','b','r'];

  function buildPolicyTable() {
    const table = [];

    // QUEEN MOVES (Types 0-55: 8 directions * 7 distances)
    // Lc0 order: Direction then Distance then Square
    for (const [dr, dc] of QUEEN_DIRS) {
      for (let d = 1; d <= 7; d++) {
        for (let sq = 0; sq < 64; sq++) {
          const r = Math.floor(sq / 8), c = sq % 8;
          const nr = r + dr * d, nc = c + dc * d;
          if (nr >= 0 && nr < 8 && nc >= 0 && nc < 8) {
            const promo = (r === 6 && nr === 7) ? 'q' : null;
            table.push({ fromSq: sq, toSq: nr * 8 + nc, promo });
          }
        }
      }
    }

    // KNIGHT MOVES (Types 56-63)
    for (const [dr, dc] of KNIGHT_DELTAS) {
      for (let sq = 0; sq < 64; sq++) {
        const r = Math.floor(sq / 8), c = sq % 8;
        const nr = r + dr, nc = c + dc;
        if (nr >= 0 && nr < 8 && nc >= 0 && nc < 8) {
          table.push({ fromSq: sq, toSq: nr * 8 + nc, promo: null });
        }
      }
    }

    // UNDER-PROMOTIONS (Types 64-72: NW, N, NE directions)
    // Lc0 order: Direction then Piece then Square
    for (const dc_p of [-1, 0, 1]) {
      for (const promo_p of UNDER_PROMOS) {
        for (let sq = 0; sq < 64; sq++) {
          const r = Math.floor(sq / 8), c = sq % 8;
          if (r !== 6) continue;
          const nr = 7, nc = c + dc_p;
          if (nc >= 0 && nc < 8) {
            table.push({ fromSq: sq, toSq: nr * 8 + nc, promo: promo_p });
          }
        }
      }
    }

    if (table.length !== 1858) {
      console.error(`[Maia] Policy table length ${table.length} ≠ 1858!`);
    }
    return table;
  }

  const POLICY_TABLE = buildPolicyTable();

  // -------------------------------------------------------------------------
  // Leela square ↔ algebraic conversions
  // -------------------------------------------------------------------------
  const FILES = 'abcdefgh';

  function leelaSqToAlg(leelaSq, isBlack) {
    const lr = Math.floor(leelaSq / 8);
    const lf = leelaSq % 8;
    // For white: leela rank 0 = actual rank 1; for black: leela rank 0 = actual rank 8
    const actualRank0 = isBlack ? (7 - lr) : lr;
    const actualFile0 = isBlack ? (7 - lf) : lf;
    return FILES[actualFile0] + (actualRank0 + 1);
  }

  function leelaMoveToUCI({ fromSq, toSq, promo }, isBlack) {
    return leelaSqToAlg(fromSq, isBlack) + leelaSqToAlg(toSq, isBlack) + (promo || '');
  }

  // -------------------------------------------------------------------------
  // Board encoding → 112-plane float32 tensor
  // -------------------------------------------------------------------------
  const PIECE_ORDER = ['p', 'n', 'b', 'r', 'q', 'k'];

  function encodeBoard(chess) {
    const isBlack = chess.turn() === 'b';
    const us = chess.turn();
    const tensor = new Float32Array(112 * 64); // [112, 8, 8] flattened

    const board = chess.board(); // board[rankIdx][fileIdx], rankIdx 0 = rank 8

    for (let rankIdx = 0; rankIdx < 8; rankIdx++) {
      for (let fileIdx = 0; fileIdx < 8; fileIdx++) {
        const cell = board[rankIdx][fileIdx];
        if (!cell) continue;

        // Actual 0-indexed rank (0=rank1, 7=rank8)
        const actualRank0 = 7 - rankIdx;
        const actualFile0 = fileIdx;

        // Leela square for this cell (mirror ranks AND files for black)
        const leelaRank = isBlack ? (7 - actualRank0) : actualRank0;
        const leelaFile = isBlack ? (7 - actualFile0) : actualFile0;
        const leelaSq   = leelaRank * 8 + leelaFile;

        // Determine plane (0-5 = us, 6-11 = them)
        const pieceIdx = PIECE_ORDER.indexOf(cell.type);
        const plane    = (cell.color === us) ? pieceIdx : (6 + pieceIdx);

        tensor[plane * 64 + leelaSq] = 1.0;
        // Plane 12: Board presence (on-board squares are 1.0)
        tensor[12 * 64 + leelaSq] = 1.0;
      }
    }

    // --- Meta planes (104–111) ---
    const fenParts   = chess.fen().split(' ');
    const halfmove   = parseInt(fenParts[4] || '0', 10);
    const castling   = fenParts[2] || '-';

    // 109: side to move (0.0 if White, 1.0 if Black)
    if (isBlack) {
      for (let i = 0; i < 64; i++) tensor[109 * 64 + i] = 1.0;
    }

    // 104-107: castling (ourKS, ourQS, theirKS, theirQS)
    const wK = castling.includes('K') ? 1 : 0;
    const wQ = castling.includes('Q') ? 1 : 0;
    const bK = castling.includes('k') ? 1 : 0;
    const bQ = castling.includes('q') ? 1 : 0;
    const castleValues = isBlack
      ? [bK, bQ, wK, wQ]
      : [wK, wQ, bK, bQ];
    for (let p = 0; p < 4; p++) {
      if (castleValues[p]) {
        for (let i = 0; i < 64; i++) tensor[(104 + p) * 64 + i] = 1.0;
      }
    }

    // 108: 50-move rule counter (normalized by 99)
    const halfNorm = Math.min(halfmove / 99, 1);
    for (let i = 0; i < 64; i++) tensor[108 * 64 + i] = halfNorm;

    // 111: all ones (constant plane)
    for (let i = 0; i < 64; i++) tensor[111 * 64 + i] = 1.0;

    // 105 used for move count in previous attempt? No, 112-plane usually doesn't include it like that.
    // 105 is now part of castling rights above (104-107).

    return tensor;
  }

  // -------------------------------------------------------------------------
  // Inference session
  // -------------------------------------------------------------------------
  let session = null;
  let loadError = null;

  async function loadModel(modelPath = './models/maia-1500.onnx') {
    try {
      session = await ort.InferenceSession.create(modelPath, {
        executionProviders: ['wasm'],
        graphOptimizationLevel: 'all',
      });
      console.log('[Maia] Model loaded:', modelPath);
      console.log('[Maia] Input names:', session.inputNames);
      console.log('[Maia] Output names:', session.outputNames);
      return true;
    } catch (err) {
      loadError = err;
      console.error('[Maia] Failed to load model:', err);
      return false;
    }
  }

  /**
   * Get move probabilities from Maia for the current position.
   * Returns array of {move (verbose chess.js obj), uci, prob} sorted desc by prob.
   * Only includes legal moves.
   */
  async function getMaiaProbs(chess) {
    if (!session) {
      throw new Error(loadError
        ? `Maia model failed to load: ${loadError.message}`
        : 'Maia model not loaded yet. Call loadModel() first.');
    }

    const isBlack = chess.turn() === 'b';
    const inputData = encodeBoard(chess);
    const inputTensor = new ort.Tensor('float32', inputData, [1, 112, 8, 8]);

    // Auto-detect the model's actual input name (varies by conversion tool)
    const inputName = session.inputNames[0];
    const outputMap = await session.run({ [inputName]: inputTensor });

    // Get first output (policy logits)
    const policyKey = Object.keys(outputMap)[0];
    const logits = outputMap[policyKey].data; // Float32Array of length 1858

    // Softmax
    const maxLogit = Math.max(...logits);
    const exps = Array.from(logits).map(x => Math.exp(x - maxLogit));
    const sumExp = exps.reduce((a, b) => a + b, 0);
    const probs = exps.map(x => x / sumExp);

    // Get all legal moves (verbose)
    const legalMoves = chess.moves({ verbose: true });

    // Build a set of legal move UCI strings for fast lookup
    const legalUCISet = new Map();
    for (const m of legalMoves) {
      const uci = m.from + m.to + (m.promotion || '');
      legalUCISet.set(uci, m);
    }

    // Map policy indices to legal moves
    const result = [];
    for (let i = 0; i < 1858; i++) {
      const entry = POLICY_TABLE[i];
      const uci   = leelaMoveToUCI(entry, isBlack);
      if (legalUCISet.has(uci)) {
        result.push({
          move: legalUCISet.get(uci),
          uci,
          prob: probs[i],
        });
      }
    }

    // If some legal moves have zero policy coverage, assign tiny uniform prob
    if (result.length < legalMoves.length) {
      const covered = new Set(result.map(r => r.uci));
      const eps = 1e-5;
      for (const [uci, move] of legalUCISet.entries()) {
        if (!covered.has(uci)) result.push({ move, uci, prob: eps });
      }
    }

    // Sort descending by probability
    result.sort((a, b) => b.prob - a.prob);
    return result;
  }

  return { loadModel, getMaiaProbs, encodeBoard, POLICY_TABLE };
})();

window.MAIA = MAIA;
