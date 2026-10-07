# PyInstaller one-folder build. No runtime Python/Node installation is required.
from pathlib import Path
import sys
from PyInstaller.utils.hooks import collect_submodules

root = Path(SPECPATH).resolve().parents[1]
datas = [(str(root / 'web' / 'dist'), 'web/dist'),
         (str(root / 'api' / 'demo'), 'api/demo'),
         (str(root / 'LICENSE'), '.'),
         (str(root / 'docs' / 'WINDOWS.md'), '.')]
# The backend fingerprints these files to distinguish a running older version.
datas.extend((str(file), 'api') for file in sorted((root / 'api').glob('*.py')))
a = Analysis([str(root / 'scripts' / 'windows' / 'desktop-entry.py')],
             pathex=[str(root)], binaries=[], datas=datas,
             hiddenimports=collect_submodules('uvicorn') + ['api.main', 'api.demo_data'],
             hookspath=[], hooksconfig={}, runtime_hooks=[],
             excludes=['pytest', 'PIL', 'httpx'], noarchive=False)
pyz = PYZ(a.pure)
exe = EXE(pyz, a.scripts, [], exclude_binaries=True, name='Odylic Constellation',
          debug=False, bootloader_ignore_signals=False, strip=False, upx=False,
          console=False, icon=str(root / 'scripts' / 'windows' / 'app.ico'),
          version=str(root / 'scripts' / 'windows' / 'version-info.txt'))
coll = COLLECT(exe, a.binaries, a.datas, strip=False, upx=False, name='Odylic Constellation')
