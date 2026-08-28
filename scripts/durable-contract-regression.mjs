const MANIFEST_KIND = "eve-durable-contracts";
const SHA256_PATTERN = /^sha256:[\da-f]{64}$/u;

export function findDurableContractRegressions(baseValue, candidateValue) {
  const base = normalizeManifest(baseValue, "base");
  const candidate = normalizeManifest(candidateValue, "candidate");
  const regressions = [];

  compareContracts("data contract", base.dataContracts, candidate.dataContracts, regressions);
  compareContracts("workflow", base.workflows, candidate.workflows, regressions);
  return regressions;
}

function compareContracts(kind, baseContracts, candidateContracts, regressions) {
  const candidatesByName = new Map(candidateContracts.map((contract) => [contract.name, contract]));
  for (const base of baseContracts) {
    const candidate = candidatesByName.get(base.name);
    if (candidate === undefined) {
      regressions.push(`Removed durable ${kind} "${base.name}".`);
      continue;
    }
    if (base.workflowId !== undefined && candidate.workflowId !== base.workflowId) {
      regressions.push(
        `Changed stable workflow id for "${base.name}" from "${base.workflowId}" to "${candidate.workflowId}".`,
      );
    }
    compareVersions(kind, base, candidate, regressions);
  }
}

function compareVersions(kind, base, candidate, regressions) {
  if (
    base.currentVersion !== null &&
    (candidate.currentVersion === null || candidate.currentVersion < base.currentVersion)
  ) {
    regressions.push(
      `Decreased ${kind} "${base.name}" current version from ${base.currentVersion} to ${String(candidate.currentVersion)}.`,
    );
  }

  if (
    base.currentVersion !== null &&
    candidate.currentVersion !== null &&
    candidate.currentVersion > base.currentVersion &&
    !candidate.acceptedVersions?.includes(base.currentVersion)
  ) {
    regressions.push(
      `Bumped ${kind} "${base.name}" without accepting previous current version ${base.currentVersion}.`,
    );
  }

  if (base.acceptedVersions !== null) {
    for (const version of base.acceptedVersions) {
      if (!candidate.acceptedVersions?.includes(version)) {
        regressions.push(`Removed accepted ${kind} "${base.name}" version ${version}.`);
      }
    }
  }

  for (const [version, baseHash] of Object.entries(base.schemaHashes)) {
    if (baseHash !== null && candidate.schemaHashes[version] !== baseHash) {
      const candidateHash = candidate.schemaHashes[version];
      regressions.push(
        candidateHash === undefined || candidateHash === null
          ? `Removed schema hash for ${kind} "${base.name}" version ${version}.`
          : `Changed schema hash for ${kind} "${base.name}" version ${version}.`,
      );
    }
  }
}

function normalizeManifest(value, label) {
  const manifest = record(value, `${label} manifest`);
  if (manifest.kind !== MANIFEST_KIND) {
    throw new Error(`${label} manifest kind must be "${MANIFEST_KIND}".`);
  }
  if (manifest.formatVersion !== 1 && manifest.formatVersion !== 2) {
    throw new Error(`${label} manifest formatVersion must be 1 or 2.`);
  }
  return {
    dataContracts: array(manifest.dataContracts, `${label} manifest dataContracts`).map(
      (contract, index) => normalizeDataContract(contract, manifest.formatVersion, label, index),
    ),
    workflows: array(manifest.workflows, `${label} manifest workflows`).map((contract, index) =>
      normalizeWorkflowContract(contract, manifest.formatVersion, label, index),
    ),
  };
}

function normalizeDataContract(value, formatVersion, label, index) {
  const path = `${label} dataContracts[${index}]`;
  const contract = record(value, path);
  const currentVersion = version(contract.currentVersion, `${path}.currentVersion`, false);
  return {
    acceptedVersions:
      formatVersion === 1
        ? null
        : acceptedVersions(contract.acceptedVersions, `${path}.acceptedVersions`, currentVersion),
    currentVersion,
    name: nonemptyString(contract.name, `${path}.name`),
    schemaHashes:
      formatVersion === 1
        ? {}
        : schemaHashes(contract.schemaHashes, `${path}.schemaHashes`, contract.acceptedVersions),
  };
}

function normalizeWorkflowContract(value, formatVersion, label, index) {
  const path = `${label} workflows[${index}]`;
  const contract = record(value, path);
  const currentVersion = version(contract.inputVersion, `${path}.inputVersion`, true);
  return {
    acceptedVersions:
      formatVersion === 1
        ? null
        : acceptedVersions(
            contract.acceptedInputVersions,
            `${path}.acceptedInputVersions`,
            currentVersion,
          ),
    currentVersion,
    name: nonemptyString(contract.name, `${path}.name`),
    schemaHashes:
      formatVersion === 1
        ? {}
        : schemaHashes(
            contract.inputSchemaHashes,
            `${path}.inputSchemaHashes`,
            contract.acceptedInputVersions,
          ),
    workflowId: nonemptyString(contract.workflowId, `${path}.workflowId`),
  };
}

function acceptedVersions(value, path, currentVersion) {
  if (value === null) {
    return null;
  }
  const accepted = array(value, path).map((item, index) =>
    version(item, `${path}[${index}]`, false),
  );
  for (const [index, item] of accepted.entries()) {
    if (index > 0 && item <= accepted[index - 1]) {
      throw new Error(`${path} must be sorted and unique.`);
    }
  }
  if (currentVersion !== null && !accepted.includes(currentVersion)) {
    throw new Error(`${path} must include current version ${currentVersion}.`);
  }
  return accepted;
}

function schemaHashes(value, path, acceptedValue) {
  if (acceptedValue === null) {
    if (value !== null) {
      throw new Error(`${path} must be null when accepted versions are unknown.`);
    }
    return {};
  }
  const hashes = record(value, path);
  const accepted = array(acceptedValue, path.replace(/SchemaHashes|schemaHashes/u, "Versions"));
  if (Object.keys(hashes).join(",") !== accepted.join(",")) {
    throw new Error(`${path} must contain every accepted version and no others.`);
  }
  for (const [key, hash] of Object.entries(hashes)) {
    if (hash !== null && (typeof hash !== "string" || !SHA256_PATTERN.test(hash))) {
      throw new Error(`${path}.${key} must be null or a SHA-256 identity.`);
    }
  }
  return hashes;
}

function record(value, path) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} must be an object.`);
  }
  return value;
}

function array(value, path) {
  if (!Array.isArray(value)) {
    throw new Error(`${path} must be an array.`);
  }
  return value;
}

function nonemptyString(value, path) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${path} must be a non-empty string.`);
  }
  return value;
}

function version(value, path, nullable) {
  if (nullable && value === null) {
    return null;
  }
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${path} must be a non-negative integer${nullable ? " or null" : ""}.`);
  }
  return value;
}
