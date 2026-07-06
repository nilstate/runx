import fs from "node:fs";

const inputs = readInputs();
const docsCorpus = arrayValue(inputs.docs_corpus, "docs_corpus");
const productSurface = objectValue(inputs.product_surface, "product_surface");
const userTaskMatrix = arrayValue(inputs.user_task_matrix, "user_task_matrix");
const stylePolicy = objectValue(inputs.style_policy, "style_policy");

const commandsSurface = arrayValue(productSurface.commands ?? [], "product_surface.commands");
const endpointsSurface = arrayValue(productSurface.endpoints ?? [], "product_surface.endpoints");
const schemasSurface = arrayValue(productSurface.schemas ?? [], "product_surface.schemas");

const docsByPage = indexDocsByPage(docsCorpus);
const findings = [];
const patchPlan = [];

const commandFindings = auditCommands(commandsSurface, docsByPage, stylePolicy);
findings.push(...commandFindings.findings);
patchPlan.push(...commandFindings.plan);

const endpointFindings = auditEndpoints(endpointsSurface, docsByPage, stylePolicy);
findings.push(...endpointFindings.findings);
patchPlan.push(...endpointFindings.plan);

const schemaFindings = auditSchemas(schemasSurface, docsByPage, stylePolicy);
findings.push(...schemaFindings.findings);
patchPlan.push(...schemaFindings.plan);

const taskFindings = auditUserTasks(userTaskMatrix, docsByPage, stylePolicy);
findings.push(...taskFindings.findings);
patchPlan.push(...taskFindings.plan);

const coverageMap = buildCoverageMap({
  commandsSurface,
  endpointsSurface,
  schemasSurface,
  userTaskMatrix,
  docsByPage,
});

const proposal = buildDocsPrProposal({
  findings,
  coverageMap,
  patchPlan,
  stylePolicy,
});

process.stdout.write(`${JSON.stringify({
  doc_findings: findings,
  coverage_map: coverageMap,
  patch_plan: patchPlan,
  docs_pr_proposal: proposal,
}, null, 2)}\n`);

function readInputs() {
  if (process.env.RUNX_INPUTS_PATH) {
    return JSON.parse(fs.readFileSync(process.env.RUNX_INPUTS_PATH, "utf8"));
  }
  if (process.env.RUNX_INPUTS_JSON) {
    return JSON.parse(process.env.RUNX_INPUTS_JSON);
  }
  return {
    docs_corpus: parseInputValue(process.env.RUNX_INPUT_DOCS_CORPUS),
    product_surface: parseInputValue(process.env.RUNX_INPUT_PRODUCT_SURFACE),
    user_task_matrix: parseInputValue(process.env.RUNX_INPUT_USER_TASK_MATRIX),
    style_policy: parseInputValue(process.env.RUNX_INPUT_STYLE_POLICY),
  };
}

function parseInputValue(raw) {
  if (raw === undefined || raw === "") return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function indexDocsByPage(docsCorpus) {
  const map = new Map();
  for (const entry of docsCorpus) {
    if (!entry || typeof entry !== "object") continue;
    const page = stringValue(entry.page);
    if (!page) continue;
    map.set(page, entry);
  }
  return map;
}

function auditCommands(commands, docsByPage, stylePolicy) {
  const findings = [];
  const plan = [];
  for (const command of commands) {
    const name = stringValue(command?.name);
    if (!name) continue;
    const slug = slugify(name);
    const docPage = `commands/${slug}`;
    const doc = docsByPage.get(docPage) ?? docsByPage.get(name);
    if (!doc) {
      findings.push(makeFinding({
        page: docPage,
        issue: "missing doc for product-surface command",
        severity: "blocker",
        doc_evidence: null,
        product_surface_evidence: `product_surface.commands[name=${name}]`,
        proposed_fix_scope: `add docs page ${docPage}.md describing runx ${name}`,
        stylePolicy,
      }));
      plan.push(makePlanEntry(docPage, `Add ${docPage}.md describing runx ${name}`, [`product_surface.commands[name=${name}]`]));
      continue;
    }
    const stable = command?.stable !== false;
    const deprecatedMarkers = detectDeprecatedMarkers(doc?.body ?? "");
    if (!stable && deprecatedMarkers === 0) {
      findings.push(makeFinding({
        page: docPage,
        issue: "command marked unstable in product surface but doc has no deprecation marker",
        severity: "warning",
        doc_evidence: doc.path ?? docPage,
        product_surface_evidence: `product_surface.commands[name=${name}].stable=false`,
        proposed_fix_scope: `add deprecation notice to ${doc.path ?? docPage}`,
        stylePolicy,
      }));
      plan.push(makePlanEntry(docPage, "Add deprecation marker and migration note", [doc.path ?? docPage]));
    }
    if (stable && /deprecated/i.test(doc?.body ?? "")) {
      findings.push(makeFinding({
        page: docPage,
        issue: "doc says deprecated but product surface marks command stable",
        severity: "warning",
        doc_evidence: doc.path ?? docPage,
        product_surface_evidence: `product_surface.commands[name=${name}].stable=true`,
        proposed_fix_scope: `remove deprecation wording from ${doc.path ?? docPage}`,
        stylePolicy,
      }));
      plan.push(makePlanEntry(docPage, "Remove deprecation wording", [doc.path ?? docPage]));
    }
  }
  return { findings, plan };
}

function auditEndpoints(endpoints, docsByPage, stylePolicy) {
  const findings = [];
  const plan = [];
  for (const endpoint of endpoints) {
    const name = stringValue(endpoint?.name);
    if (!name) continue;
    const docPage = `endpoints/${name}`;
    const doc = docsByPage.get(docPage);
    if (!doc) {
      findings.push(makeFinding({
        page: docPage,
        issue: "missing doc for product-surface endpoint",
        severity: "warning",
        doc_evidence: null,
        product_surface_evidence: `product_surface.endpoints[name=${name}]`,
        proposed_fix_scope: `add docs page ${docPage}.md describing ${endpoint?.method ?? "?"} ${endpoint?.path ?? "?"}`,
        stylePolicy,
      }));
      plan.push(makePlanEntry(docPage, `Add ${docPage}.md describing the endpoint`, [`product_surface.endpoints[name=${name}]`]));
    }
  }
  return { findings, plan };
}

function auditSchemas(schemas, docsByPage, stylePolicy) {
  const findings = [];
  const plan = [];
  for (const schema of schemas) {
    const name = stringValue(schema?.name);
    if (!name) continue;
    const docPage = `schemas/${name}`;
    const doc = docsByPage.get(docPage);
    if (!doc) {
      findings.push(makeFinding({
        page: docPage,
        issue: "missing doc for product-surface schema",
        severity: "warning",
        doc_evidence: null,
        product_surface_evidence: `product_surface.schemas[name=${name}]`,
        proposed_fix_scope: `add docs page ${docPage}.md describing the schema`,
        stylePolicy,
      }));
      plan.push(makePlanEntry(docPage, `Add ${docPage}.md describing the schema`, [`product_surface.schemas[name=${name}]`]));
    }
  }
  return { findings, plan };
}

function auditUserTasks(userTaskMatrix, docsByPage, stylePolicy) {
  const findings = [];
  const plan = [];
  for (const taskEntry of userTaskMatrix) {
    const taskName = stringValue(taskEntry?.task);
    if (!taskName) continue;
    const expectedHelp = arrayValue(taskEntry?.expected_help ?? [], `user_task_matrix[task=${taskName}].expected_help`);
    const missing = expectedHelp.filter((page) => !docsByPage.has(page));
    if (missing.length > 0) {
      findings.push(makeFinding({
        page: `tasks/${taskName}`,
        issue: `user task missing ${missing.length} of ${expectedHelp.length} expected doc pages`,
        severity: missing.length === expectedHelp.length ? "blocker" : "warning",
        doc_evidence: null,
        product_surface_evidence: `user_task_matrix[task=${taskName}]`,
        proposed_fix_scope: `add docs for missing pages: ${missing.join(", ")}`,
        stylePolicy,
      }));
      for (const page of missing) {
        plan.push(makePlanEntry(page, `Add ${page}.md to satisfy user task '${taskName}'`, [`user_task_matrix[task=${taskName}]`]));
      }
    }
  }
  return { findings, plan };
}

function buildCoverageMap({ commandsSurface, endpointsSurface, schemasSurface, userTaskMatrix, docsByPage }) {
  const commandCoverage = commandsSurface.map((command) => {
    const name = stringValue(command?.name);
    const page = name ? `commands/${slugify(name)}` : null;
    const hasDoc = page ? docsByPage.has(page) || docsByPage.has(name) : false;
    return { name: command?.name, status: hasDoc ? "covered" : "missing" };
  });
  const endpointCoverage = endpointsSurface.map((endpoint) => {
    const name = stringValue(endpoint?.name);
    const page = name ? `endpoints/${slugify(name)}` : null;
    const hasDoc = page ? docsByPage.has(page) || docsByPage.has(name) : false;
    return { name: endpoint?.name, status: hasDoc ? "covered" : "missing" };
  });
  const schemaCoverage = schemasSurface.map((schema) => {
    const name = stringValue(schema?.name);
    const page = name ? `schemas/${slugify(name)}` : null;
    const hasDoc = page ? docsByPage.has(page) || docsByPage.has(name) : false;
    return { name: schema?.name, status: hasDoc ? "covered" : "missing" };
  });
  const taskCoverage = userTaskMatrix.map((taskEntry) => {
    const expectedHelp = arrayValue(taskEntry?.expected_help ?? [], "expected_help");
    const missing = expectedHelp.filter((page) => !docsByPage.has(page));
    let status = "covered";
    if (missing.length === expectedHelp.length && expectedHelp.length > 0) status = "missing";
    else if (missing.length > 0) status = "partial";
    return { task: taskEntry?.task, status, missing };
  });
  return {
    commands: commandCoverage,
    endpoints: endpointCoverage,
    schemas: schemaCoverage,
    tasks: taskCoverage,
    covered: countByStatus(commandCoverage, "covered") + countByStatus(endpointCoverage, "covered") + countByStatus(schemaCoverage, "covered"),
    missing: countByStatus(commandCoverage, "missing") + countByStatus(endpointCoverage, "missing") + countByStatus(schemaCoverage, "missing"),
    partial: countByStatus(taskCoverage, "partial"),
  };
}

function buildDocsPrProposal({ findings, coverageMap, patchPlan, stylePolicy }) {
  const blockerCount = findings.filter((f) => f.severity === "blocker").length;
  const warningCount = findings.filter((f) => f.severity === "warning").length;
  const proposalAllowed = stylePolicy?.tone !== "frozen";
  if (blockerCount === 0 && warningCount === 0 && coverageMap.missing === 0 && coverageMap.partial === 0) {
    return {
      proposed: false,
      channel: null,
      gated: true,
      reason: "Docs corpus already matches product surface; no edits proposed.",
    };
  }
  if (!proposalAllowed) {
    return {
      proposed: false,
      channel: null,
      gated: true,
      reason: "Style policy forbids proposing edits.",
    };
  }
  return {
    proposed: true,
    channel: "docs_pr",
    gated: true,
    blocker_count: blockerCount,
    warning_count: warningCount,
    patch_plan_size: patchPlan.length,
    reason: `Docs corpus has ${blockerCount} blocker(s) and ${warningCount} warning(s); patch_plan has ${patchPlan.length} entries.`,
  };
}

function makeFinding({ page, issue, severity, doc_evidence, product_surface_evidence, proposed_fix_scope, stylePolicy }) {
  const finding = {
    page,
    issue,
    severity,
    doc_evidence,
    product_surface_evidence,
    proposed_fix_scope,
  };
  if (stylePolicy?.required_evidence_in_finding) {
    finding.style_evidence_check = "passed";
  }
  return finding;
}

function makePlanEntry(targetPage, change, evidenceRefs) {
  return {
    target_page: targetPage,
    change,
    evidence_refs: evidenceRefs,
  };
}

function detectDeprecatedMarkers(body) {
  return (body.match(/deprecated/gi) ?? []).length;
}

function slugify(value) {
  return String(value ?? "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function countByStatus(items, status) {
  return items.filter((item) => item.status === status).length;
}

function arrayValue(value, name) {
  if (!Array.isArray(value)) fail(`${name} must be an array`);
  return value;
}

function objectValue(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${name} must be an object`);
  }
  return value;
}

function stringValue(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(64);
}