#!/bin/sh
W=/tmp/openpdf-design; O=$W/cmp_all.out; : > $O
podman rm -f ocr-new-t >/dev/null 2>&1
podman run -d --name ocr-new-t -p 127.0.0.1:18192:8091 localhost/pdf-gateway-ocr:latest >/dev/null; sleep 4
for d in /w/ocrbench /w/ocrhard; do
  podman run --rm --network host --user 0 -v $W:/w:Z localhost/pdf-gateway-ocr:latest \
    python3 /w/tess_dir.py $d http://127.0.0.1:18192 >> $O 2>&1
  podman run --rm --user 0 -v $W:/w:Z localhost/openpdf-rapidocr-proto \
    python3 /w/rapid/final_rapid.py $d 2>&1 | grep -v -E "^\[|INFO|Download|%\|" >> $O
done
podman rm -f ocr-new-t >/dev/null 2>&1
echo DONE >> $O
