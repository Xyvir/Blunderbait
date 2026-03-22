/**
 * worker.js — Stockfish Web Worker
 *
 * stockfish.js is designed to be used as a complete worker script — NOT
 * imported inside another worker via importScripts. This file simply
 * re-exports everything stockfish.js provides by loading it as the
 * worker's own script.
 *
 * Usage in main thread:
 *   const worker = new Worker('./stockfish.js');   // use stockfish.js directly
 *
 * This file is kept as a thin shim for any custom initialization, but
 * WorkerHelper in bbi.js now points directly to './stockfish.js'.
 */

// This file is intentionally minimal — see bbi.js WorkerHelper.
// The real worker is stockfish.js used directly.
