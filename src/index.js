const core = require("@actions/core");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

// License compatibility matrix
// For a project under license X, which dependency licenses are compatible?
const COMPATIBILITY = {
  "MIT": {
    compatible: ["MIT", "ISC", "BSD-2-Clause", "BSD-3-Clause", "Apache-2.0", "0BSD", "Unlicense", "CC0-1.0", "WTFPL", "Zlib", "BlueOak-1.0.0"],
    incompatible: ["GPL-2.0-only", "GPL-3.0-only", "AGPL-3.0-only", "SSPL-1.0", "EUPL-1.2"],
    conditional: ["LGPL-2.1-only", "LGPL-3.0-only", "MPL-2.0", "EPL-2.0"],
  },
  "Apache-2.0": {
    compatible: ["MIT", "ISC", "BSD-2-Clause", "BSD-3-Clause", "Apache-2.0", "0BSD", "Unlicense", "CC0-1.0", "WTFPL"],
    incompatible: ["GPL-2.0-only", "AGPL-3.0-only", "SSPL-1.0"],
    conditional: ["GPL-3.0-only", "LGPL-2.1-only", "LGPL-3.0-only", "MPL-2.0", "EPL-2.0"],
  },
  "GPL-3.0-only": {
    compatible: ["MIT", "ISC", "BSD-2-Clause", "BSD-3-Clause", "Apache-2.0", "GPL-3.0-only", "LGPL-3.0-only", "GPL-2.0-only", "LGPL-2.1-only", "MPL-2.0", "0BSD", "Unlicense", "CC0-1.0"],
    incompatible: ["AGPL-3.0-only", "SSPL-1.0"],
    conditional: ["EPL-2.0", "CDDL-1.0"],
  },
  "AGPL-3.0-only": {
    compatible: ["MIT", "ISC", "BSD-2-Clause", "BSD-3-Clause", "Apache-2.0", "GPL-3.0-only", "AGPL-3.0-only", "LGPL-3.0-only", "MPL-2.0", "0BSD", "Unlicense", "CC0-1.0"],
    incompatible: ["SSPL-1.0"],
    conditional: ["GPL-2.0-only", "LGPL-2.1-only"],
  },
};

function detectPackageManager() {
  if (fs.existsSync("package-lock.json") || fs.existsSync("package.json")) return "npm";
  if (fs.existsSync("yarn.lock")) return "npm";
  if (fs.existsSync("pnpm-lock.yaml")) return "npm";
  if (fs.existsSync("requirements.txt") || fs.existsSync("setup.py") || fs.existsSync("pyproject.toml")) return "pip";
  if (fs.existsSync("Cargo.lock") || fs.existsSync("Cargo.toml")) return "cargo";
  if (fs.existsSync("go.mod")) return "go";
  if (fs.existsSync("pom.xml")) return "maven";
  if (fs.existsSync("build.gradle") || fs.existsSync("build.gradle.kts")) return "gradle";
  return null;
}

function parseNpmDependencies() {
  const deps = [];
  try {
    const output = execSync("npm ls --all --json 2>/dev/null || true", { encoding: "utf8", maxBuffer: 50 * 1024 * 1024 });
    const tree = JSON.parse(output);
    function walk(node, depth) {
      const dependencies = node.dependencies || {};
      for (const [name, info] of Object.entries(dependencies)) {
        deps.push({
          name,
          version: info.version || "unknown",
          license: "unknown", // Will be resolved below
          depth,
        });
        if (depth < 3) walk(info, depth + 1);
      }
    }
    walk(tree, 0);
  } catch {
    // Fallback: parse package-lock.json
    if (fs.existsSync("package-lock.json")) {
      const lock = JSON.parse(fs.readFileSync("package-lock.json", "utf8"));
      const packages = lock.packages || {};
      for (const [key, info] of Object.entries(packages)) {
        if (!key) continue;
        const name = key.replace("node_modules/", "");
        deps.push({
          name,
          version: info.version || "unknown",
          license: info.license || "unknown",
          depth: (key.match(/node_modules/g) || []).length,
        });
      }
    }
  }

  // Resolve licenses from node_modules
  for (const dep of deps) {
    if (dep.license === "unknown") {
      const pkgPath = path.join("node_modules", dep.name, "package.json");
      if (fs.existsSync(pkgPath)) {
        try {
          const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
          dep.license = typeof pkg.license === "string" ? pkg.license :
            typeof pkg.license === "object" ? pkg.license.type || "unknown" : "unknown";
        } catch { /* ignore */ }
      }
    }
  }
  return deps;
}

function parsePipDependencies() {
  const deps = [];
  try {
    const output = execSync("pip licenses --format=json 2>/dev/null || true", { encoding: "utf8" });
    const licenses = JSON.parse(output);
    for (const pkg of licenses) {
      deps.push({
        name: pkg.Name,
        version: pkg.Version,
        license: pkg.License || "unknown",
        depth: 0,
      });
    }
  } catch {
    // Fallback: parse requirements.txt
    if (fs.existsSync("requirements.txt")) {
      const content = fs.readFileSync("requirements.txt", "utf8");
      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const match = trimmed.match(/^([a-zA-Z0-9_-]+)/);
        if (match) {
          deps.push({ name: match[1], version: "unknown", license: "unknown", depth: 0 });
        }
      }
    }
  }
  return deps;
}

function generateSBOM(deps, format, projectName) {
  if (format === "cyclonedx") {
    return {
      bomFormat: "CycloneDX",
      specVersion: "1.5",
      version: 1,
      metadata: {
        timestamp: new Date().toISOString(),
        component: { type: "application", name: projectName },
      },
      components: deps.map((d) => ({
        type: "library",
        name: d.name,
        version: d.version,
        licenses: d.license !== "unknown" ? [{ license: { id: d.license } }] : [],
      })),
    };
  }
  // SPDX format
  return {
    spdxVersion: "SPDX-2.3",
    dataLicense: "CC0-1.0",
    SPDXID: "SPDXRef-DOCUMENT",
    name: projectName,
    documentNamespace: `https://spdx.org/spdxdocs/${projectName}`,
    creationInfo: {
      created: new Date().toISOString(),
      creators: ["Tool: license-compliance-action"],
    },
    packages: deps.map((d, i) => ({
      SPDXID: `SPDXRef-Package-${i}`,
      name: d.name,
      versionInfo: d.version,
      licenseConcluded: d.license !== "unknown" ? d.license : "NOASSERTION",
      downloadLocation: "NOASSERTION",
    })),
  };
}

function checkCompatibility(projectLicense, depLicense, denyList, allowList) {
  if (allowList.has(depLicense)) return "allowed";
  if (denyList.has(depLicense)) return "denied";

  const compat = COMPATIBILITY[projectLicense];
  if (!compat) return "unknown";

  if (compat.compatible.includes(depLicense)) return "compatible";
  if (compat.incompatible.includes(depLicense)) return "incompatible";
  if (compat.conditional.includes(depLicense)) return "conditional";
  return "unknown";
}

async function run() {
  const projectLicense = core.getInput("project-license");
  let packageManager = core.getInput("package-manager");
  const sbomFormat = core.getInput("sbom-format");
  const sbomOutput = core.getInput("sbom-output");
  const denyLicenses = new Set(core.getInput("deny-licenses").split(",").map((l) => l.trim()).filter(Boolean));
  const allowLicenses = new Set(core.getInput("allow-licenses").split(",").map((l) => l.trim()).filter(Boolean));
  const failOnIncompat = core.getInput("fail-on-incompatible") === "true";

  if (packageManager === "auto") {
    packageManager = detectPackageManager();
    if (!packageManager) {
      core.warning("Could not detect package manager");
      return;
    }
  }

  core.info(`Detected package manager: ${packageManager}`);

  let deps;
  switch (packageManager) {
    case "npm": deps = parseNpmDependencies(); break;
    case "pip": deps = parsePipDependencies(); break;
    default:
      core.warning(`Package manager '${packageManager}' not yet fully supported`);
      deps = [];
  }

  core.info(`Found ${deps.length} dependencies`);

  // Check compatibility
  const results = deps.map((d) => ({
    ...d,
    status: checkCompatibility(projectLicense, d.license, denyLicenses, allowLicenses),
  }));

  const incompatible = results.filter((r) => r.status === "incompatible" || r.status === "denied");
  const conditional = results.filter((r) => r.status === "conditional");
  const unknown = results.filter((r) => r.status === "unknown" && r.license === "unknown");

  // Generate SBOM
  const projectName = path.basename(process.cwd());
  const sbom = generateSBOM(deps, sbomFormat, projectName);
  fs.writeFileSync(sbomOutput, JSON.stringify(sbom, null, 2));

  core.setOutput("total-dependencies", deps.length.toString());
  core.setOutput("incompatible-count", incompatible.length.toString());
  core.setOutput("sbom-path", sbomOutput);

  // Summary
  core.summary.addHeading("📜 License Compliance Report", 2);
  core.summary.addRaw(`**Project license:** ${projectLicense} | **Dependencies:** ${deps.length} | **SBOM:** \`${sbomOutput}\`\n\n`);

  core.summary.addTable([
    [{ data: "Status", header: true }, { data: "Count", header: true }],
    ["✅ Compatible", results.filter((r) => r.status === "compatible" || r.status === "allowed").length.toString()],
    ["🔴 Incompatible", incompatible.length.toString()],
    ["🟡 Conditional", conditional.length.toString()],
    ["❓ Unknown", unknown.length.toString()],
  ]);

  if (incompatible.length > 0) {
    core.summary.addHeading("Incompatible Licenses", 3);
    for (const dep of incompatible) {
      core.summary.addRaw(`🔴 **${dep.name}@${dep.version}** — License: \`${dep.license}\` (${dep.status})\n`);
    }
  }
  if (conditional.length > 0) {
    core.summary.addHeading("Conditional Licenses (review needed)", 3);
    for (const dep of conditional) {
      core.summary.addRaw(`🟡 **${dep.name}@${dep.version}** — License: \`${dep.license}\`\n`);
    }
  }

  await core.summary.write();

  if (failOnIncompat && incompatible.length > 0) {
    core.setFailed(`Found ${incompatible.length} incompatible license(s)`);
  }
}

run().catch((error) => core.setFailed(error.message));
