"""Write dsh-code-workbench/update.json: the manifest the in-app updater reads.

The published release is the authority on what an installation should contain, so
the manifest hashes what the repository holds rather than what one working tree
happens to look like. Git stores every one of these files with LF; on Windows
`core.autocrlf=true` checks them out as CRLF, and a tarball packed from that tree
keeps the CRLF. All three are the same source, so the digest is taken over
LF-normalised bytes -- which is also what the updater hashes an installed file
with before comparing. Without that, an installation made from a locally packed
tarball would look permanently out of date.

The file list comes from the package's own `files` field, so the manifest
describes exactly what a tarball ships. `update.json` itself is never listed: a
manifest cannot be its own entry, and an installation must not be asked to
replace it while the Host is reading it.

Run this after `npm run build` and commit the result with the release it
describes. The release commit, the tag on it, and this manifest must agree, or
the updater will compare against a version the repository never published.
"""
import hashlib
import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
PACKAGE = ROOT / "dsh-code-workbench"
MANIFEST = PACKAGE / "update.json"
# npm always ships these alongside the `files` field, so an installation has them too.
ALWAYS = ["package.json", "LICENSE", "README.md"]
# Nothing here is ever published: the manifest describes the package without
# describing itself, and a lockfile is not part of what `files` ships.
SKIP = {"update.json", "package-lock.json"}


def normalise(data: bytes) -> bytes:
    """LF-normalised bytes -- the form git stores these text files in."""
    return data.replace(b"\r\n", b"\n")


def shipped() -> list[pathlib.Path]:
    """Every file the package publishes, as absolute paths, sorted."""
    declared = json.loads((PACKAGE / "package.json").read_text(encoding="utf-8")).get("files") or []
    found: set[pathlib.Path] = set()
    for entry in [*declared, *ALWAYS]:
        target = PACKAGE / entry
        if target.is_dir():
            found.update(path for path in target.rglob("*") if path.is_file())
        elif target.is_file():
            found.add(target)
    return sorted(
        (path for path in found if path.name not in SKIP and "node_modules" not in path.parts),
        key=lambda path: path.relative_to(PACKAGE).as_posix(),
    )


def main() -> int:
    version = json.loads((PACKAGE / "package.json").read_text(encoding="utf-8"))["version"]
    files = shipped()
    if not files:
        print("no files to describe", file=sys.stderr)
        return 1

    digests = {}
    normalised = []
    for path in files:
        relative = path.relative_to(PACKAGE).as_posix()
        raw = path.read_bytes()
        if normalise(raw) != raw:
            normalised.append(relative)
        digests[relative] = hashlib.sha256(normalise(raw)).hexdigest()

    MANIFEST.write_text(json.dumps({"version": version, "files": digests}, indent=2, sort_keys=True) + "\n",
                        encoding="utf-8", newline="\n")
    print(f"{MANIFEST.relative_to(ROOT)}: version {version}, {len(digests)} files")
    for relative in normalised:
        print(f"  normalised CRLF -> LF: {relative}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
