import onnxruntime as ort
import sys

try:
    session = ort.InferenceSession('models/maia_rapid.onnx')
    print("Inputs:")
    for input in session.get_inputs():
        print(f"  {input.name}: {input.shape}, {input.type}")
    print("\nOutputs:")
    for output in session.get_outputs():
        print(f"  {output.name}: {output.shape}, {output.type}")
except Exception as e:
    print(f"Error: {e}")
