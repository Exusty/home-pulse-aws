"""Fetch only pinned public dependency files and verify deployed bytes."""
from pathlib import Path
import hashlib,json,urllib.request
root=Path(__file__).resolve().parents[1]
revision="318e8dad55c12a1c6faddbec5f30489d2ee529ff"
manifest=json.loads((root/"config/upstream-files.json").read_text())
for relative,meta in manifest.items():
    url="https://raw.githubusercontent.com/mohit67890/imajev/"+revision+"/"+relative
    data=urllib.request.urlopen(url,timeout=60).read()
    candidates=[data,data.replace(b"\r\n",b"\n").replace(b"\n",b"\r\n")]
    data=next((b for b in candidates if hashlib.sha256(b).hexdigest()==meta["sha256"]),None)
    if data is None:raise RuntimeError("Dependency hash mismatch: "+relative)
    target=root/"upstream"/relative
    target.parent.mkdir(parents=True,exist_ok=True)
    target.write_bytes(data)
(root/"upstream/LICENSE").write_bytes((root/"licenses/imajev-APACHE-2.0.txt").read_bytes())
print("Verified",len(manifest),"public dependency files")
