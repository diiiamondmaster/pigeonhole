#!/bin/bash
# Capture every major UI state into dev-shots/ for visual review.
# Usage: bash scripts/dev-shots.sh   (needs DISPLAY set, e.g. :99)
set -u
cd "$(dirname "$0")/.."
mkdir -p dev-shots
E="npx electron . --no-sandbox --demo --serve-dev"

run() { # name scene wait extra-args
  local name="$1" scene="$2" wait="$3"; shift 3
  echo "--- shot: $name"
  DISPLAY=${DISPLAY:-:99} $E --scene="$scene" --shot="dev-shots/$name.png" --wait="$wait" "$@" 2>&1 | grep -E "\[shot\]|Uncaught|wizard-test" | head -4
}

run boot main 3200
run ntp ntp 2600
run wizard wizard 1600
run wizard-provider wizard-provider 1600
run wizard-create wizard-create 7000
run vault vault 2200
run settings settings 1600
run settings-identity settings-identity 1600
run ws-settings ws-settings 1600
run offer offer 5200
run many many 2200
run collapsed collapsed 1600
run error error 4500

echo "--- montages"
python3 - <<'EOF'
from PIL import Image
import os
os.makedirs('dev-shots', exist_ok=True)

def montage(files, out, cols=2):
    imgs = [Image.open(f'dev-shots/{f}.png').convert('RGB') for f in files]
    w = 640
    scaled = [im.resize((w, int(im.height * w / im.width))) for im in imgs]
    rows = (len(scaled) + cols - 1) // cols
    ch = max(im.height for im in scaled)
    canvas = Image.new('RGB', (w * cols + 12 * (cols + 1), ch * rows + 12 * (rows + 1)), (40, 44, 52))
    for i, im in enumerate(scaled):
        r, c = divmod(i, cols)
        canvas.paste(im, (12 + c * (w + 12), 12 + r * (ch + 12)))
    canvas.save(f'dev-shots/{out}.png')
    print('montage saved', out, canvas.size)

montage(['boot', 'ntp'], 'm-browsing')
montage(['wizard', 'wizard-provider'], 'm-wizard-pick')
montage(['wizard-create', 'vault'], 'm-wizard-create')
montage(['settings', 'ws-settings'], 'm-settings')
montage(['offer', 'many', 'collapsed', 'error'], 'm-misc', cols=2)
EOF
echo done
