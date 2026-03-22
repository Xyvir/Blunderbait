"""
convert_maia.py
---------------
Converts a Maia lc0 .pb.gz (TensorFlow frozen graph) to ONNX
so it can be loaded by onnxruntime-web in the browser.

Requirements:
    pip install tf2onnx tensorflow

Usage:
    python convert_maia.py maia-1500.pb.gz

Output:
    maia-1500.onnx   (placed next to input file, ready for ./models/)
"""

import sys
import os
import gzip
import shutil
import subprocess
import tempfile

def main():
    if len(sys.argv) < 2:
        print("Usage: python convert_maia.py <path_to_maia_model.pb.gz>")
        sys.exit(1)

    pb_gz_path = sys.argv[1]
    if not os.path.exists(pb_gz_path):
        print(f"ERROR: File not found: {pb_gz_path}")
        sys.exit(1)

    base       = os.path.splitext(os.path.splitext(pb_gz_path)[0])[0]  # strip .pb.gz
    pb_path    = base + ".pb"
    onnx_path  = base + ".onnx"

    print(f"[1/3] Decompressing {pb_gz_path} → {pb_path}")
    with gzip.open(pb_gz_path, 'rb') as f_in:
        with open(pb_path, 'wb') as f_out:
            shutil.copyfileobj(f_in, f_out)

    # The lc0/Maia pb files have these output nodes:
    # policy_head output:  "policy/Policy/softmax"  OR  "policy"
    # value  head output:  "value/Value/Tanh"        OR  "value"
    # We try both naming conventions.

    print(f"[2/3] Converting frozen graph → ONNX …")
    output_node_candidates = [
        "policy/Policy/softmax,value/Value/Tanh",   # older Maia / lc0 naming
        "policy,value",                              # simpler naming
        "output/policy,output/value",
    ]

    converted = False
    for nodes in output_node_candidates:
        cmd = [
            sys.executable, "-m", "tf2onnx.convert",
            "--input", pb_path,
            "--output", onnx_path,
            "--outputs", nodes,
            "--opset", "13",
            "--fold_const",
        ]
        print(f"   Trying output nodes: {nodes}")
        result = subprocess.run(cmd, capture_output=True, text=True)
        if result.returncode == 0:
            converted = True
            break
        print(f"   → failed ({result.stderr.strip()[-200:]})")

    if not converted:
        print("\nERROR: All output-node naming conventions failed.")
        print("Try running tf2onnx manually to inspect the graph:")
        print(f"  python -m tf2onnx.convert --input {pb_path} --output {onnx_path} --outputs <your_output_nodes> --opset 13")
        print("\nTo list all node names in the graph:")
        print("  python -c \"import tensorflow as tf; g=tf.compat.v1.GraphDef(); g.ParseFromString(open(r'" + pb_path + "','rb').read()); [print(n.name) for n in g.node]\"")
        sys.exit(1)

    size_mb = os.path.getsize(onnx_path) / (1024*1024)
    print(f"[3/3] Done! Saved to: {onnx_path}  ({size_mb:.1f} MB)")
    print(f"\nNext step: copy {onnx_path} to  BBI_Dev/models/maia-1500.onnx")

if __name__ == "__main__":
    main()
