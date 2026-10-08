"""Build the distribution zip from the npm tarball.

The tarball is the source of truth for what ships; the zip mirrors it under a
`dsh-code-workbench/` prefix. npm pack stores members under `package/`, which
is stripped and re-prefixed here. Python's zipfile always writes forward-slash
entry names, unlike PowerShell 5.1's Compress-Archive, whose backslash names
extract as literal filenames on macOS/Linux.

  python tools/make-dist-zip.py outputs/dsh-code-workbench-0.4.1.tgz
"""

import json
import pathlib
import sys
import tarfile
import zipfile

if len(sys.argv) != 2:
    sys.exit(f"usage: {sys.argv[0]} <tarball>")

tar_path = pathlib.Path(sys.argv[1]).resolve()
if not tar_path.exists():
    sys.exit(f"no such tarball: {tar_path}")

zip_path = tar_path.parent / (tar_path.name.removesuffix(".tgz") + ".zip")

with tarfile.open(tar_path, "r:gz") as tar:
    members = tar.getmembers()
    manifest = json.loads(tar.extractfile("package/package.json").read())
    package_name = manifest["name"]
    prefix = package_name + "/"

    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        # The root directory entry first, matching the layout of previous releases.
        zf.writestr(zipfile.ZipInfo(prefix), b"")
        count = 0
        for member in members:
            if not member.isfile() or not member.name.startswith("package/"):
                continue
            name = prefix + member.name[len("package/"):]
            info = zipfile.ZipInfo(name)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.date_time = (2026, 1, 1, 0, 0, 0)  # fixed timestamp for reproducibility
            zf.writestr(info, tar.extractfile(member).read())
            count += 1

print(f"{zip_path.name}: {count} files under {prefix}")
