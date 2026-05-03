# 📜 License Compliance

**SBOM generation + license compatibility checking for every PR.**

> **Gap filled:** Dependency Review checks for CVEs. No existing action generates CycloneDX/SPDX SBOMs AND checks license compatibility with your project's license. Nothing answers: "will this MIT project break if I add a GPL dependency?"

## Features

- Auto-detects package manager (npm, pip, cargo, go)
- Generates CycloneDX 1.5 or SPDX 2.3 SBOMs
- License compatibility matrix for MIT, Apache-2.0, GPL-3.0, AGPL-3.0
- Custom deny/allow lists
- Blocks PRs adding incompatible dependencies

## Usage

```yaml
- uses: your-org/license-compliance@v1
  with:
    project-license: 'MIT'
    sbom-format: 'cyclonedx'
    fail-on-incompatible: 'true'
```
