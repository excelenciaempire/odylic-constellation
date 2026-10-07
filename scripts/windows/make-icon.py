from pathlib import Path
from PIL import Image

root = Path(__file__).resolve().parents[2]
with Image.open(root / 'web' / 'public' / 'app-icon.png') as icon:
    icon.convert('RGBA').save(Path(__file__).with_name('app.ico'), format='ICO',
                             sizes=[(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
