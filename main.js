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
  // Pipeline orchestration
  // -------------------------------------------------------------------------
  // (pipelineRunning and queuedFen declared at top of IIFE)

  async function triggerBBIPipeline(fen, executedMove) {
    const pipelineId = ++currentPipelineId;
    workerHelper.clear(); // Interrupt Stockfish
    UI.clearBestMoveArrow(); // Clear old arrow immediately
    UI.clearScorePanel();    // Clear old scores to avoid confusion
    UI.clearBlunderOverlay(); // Clear old ghosts

    const prevFen = currentFen;
    currentFen = fen || chess.fen();

    // Update FEN display
    document.getElementById('fen-input').value = currentFen;

    if (!modelLoaded) return;

    pipelineRunning = true;
    UI.showLoading(true, 'Evaluating position...', 0);

    try {
      const depth = parseInt(document.getElementById('depth-slider').value, 10);
      const seeThreshold = parseFloat(document.getElementById('see-slider').value);

      // Clone the board to isolate this pipeline run from future UI mutations (e.g. Undo, Next Move)
      const pipelineChess = new Chess(currentFen);

      const result = await BBI.runPipeline(pipelineChess, workerHelper, {
        seeThreshold, depth,
        onProgress: (pct) => {
          if (currentPipelineId === pipelineId) UI.updateProgress(pct);
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
          let mMatch = prevCache.moveTable.find(m => m.uci === uci);

          if (!mMatch) {
            // Fringe move manually explored by the user that the engine initially discarded.
            // Dynamically inject it into the cache trace so its future grade trap persists!
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
