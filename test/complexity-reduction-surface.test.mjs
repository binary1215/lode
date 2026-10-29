import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { catalogTools, dispatch } from '../scripts/mcp-server.mjs';
import { runCommand, usage } from '../scripts/head.mjs';
import { initializeProject, inspectProject } from '../scripts/lib/head-core.mjs';
import { buildWorldModel } from '../scripts/lib/world-model.mjs';
import { updateProjectDirection } from '../scripts/lib/project-direction.mjs';

const pluginRoot = path.resolve(import.meta.dirname, '..');
async function call(name, args) {
  const response = await dispatch({ id: 1, method: 'tools/call', params: { name, arguments: args } });
  assert.equal(response.error, undefined, JSON.stringify(response.error));
  return response.result.structuredContent;
}
function fixture(t) {
  const parent = fs.realpathSync(os.tmpdir());
  const root = fs.realpathSync(fs.mkdtempSync(path.join(parent, 'head-light-surface-')));
  t.after(() => { assert.equal(path.dirname(root), parent); fs.rmSync(root, { recursive: true, force: true }); });
  initializeProject({ root, pluginRoot, runtimes: ['codex'] });
  const layout = inspectProject(root).storage;
  fs.writeFileSync(path.join(root, 'queue.mjs'), 'export function drain(items) { return items.shift(); }\n');
  return { root, layout };
}
function originals(root, layout) {
  const files = {};
  const walk = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(file);
      else files[path.relative(root, file)] = fs.readFileSync(file).toString('base64');
    }
  };
  walk(path.join(root, layout.directory));
  assert.ok(Object.hasOwn(files, path.join(layout.directory, 'project.json')));
  assert.ok(Object.hasOwn(files, path.join(layout.directory, 'sessions', 'current.json')));
  return files;
}

test('removed role-mail APIs have no discovery, CLI or hidden dispatch route', async t => {
  const { root, layout } = fixture(t), before = originals(root, layout);
  for (const prefix of ['head', 'lode']) for (const suffix of ['send_message', 'read_inbox', 'wait_reply', 'reply_message']) {
    const name = `${prefix}_coordination_${suffix}`;
    assert(!catalogTools.some(tool => tool.name === name));
    const discovery = await dispatch({ id: 1, method: 'tools/call', params: {
      name: 'head_tools_discover', arguments: { name }
    } });
    assert.match(discovery.error?.message || '', /Unknown or unavailable tool/);
    const response = await dispatch({ id: 1, method: 'tools/call', params: { name, arguments: { project_root: root } } });
    assert(response.error, name);
  }
  for (const suffix of ['open', 'rotate', 'bind', 'status', 'send', 'inbox', 'wait-reply', 'reply']) {
    (await assert.rejects(async () => (await runCommand([`coordination-${suffix}`, root])), /Unknown command/));
  }
  assert(!usage({ all: true }).commands.some(command => /coordination-/.test(command)));
  assert.deepEqual(originals(root, layout), before);
});

test('CLI and typed MCP keep arbitrary Context budgets advisory with exact current direction', async t => {
  const { root, layout } = fixture(t);
  const direction = updateProjectDirection({ root, expectedDirectionId: null, input: {
    goal: 'Investigate the queue', constraints: ['Keep source local'], cancelledActions: ['Deploy']
  } }).direction;
  const before = originals(root, layout), task = '  Investigate queue\n';
  const prepared = await call('head_context_prepare', { project_root: root, task, budget: 50000 });
  const cliPrepared = await runCommand(['context-prepare', root, '--task', task, '--budget', '50000']);
  assert.deepEqual(prepared, cliPrepared);
  assert.equal(prepared.preparation.status, 'ready_for_head_semantic_assessment');
  assert.deepEqual(prepared.preparation.currentDirection, direction);
  const preview = await call('head_context_preview', { project_root: root, task, budget: 50000 });
  const cliPreview = await runCommand(['context-preview', root, '--task', task, '--budget', '50000']);
  assert.deepEqual(preview, cliPreview);
  assert.equal(preview.workflow.budget.requestedApproxTokens, 50000);
  assert.equal(preview.capsule.task, task);
  assert.equal(preview.workflow.authority.judgesSemanticSufficiency, false);
  assert.equal('coverageAssessment' in preview.capsule, false);
  assert.equal('attemptedTiers' in preview.workflow.budget, false);
  assert.deepEqual(originals(root, layout), before);
});

test('CLI and typed MCP share compact graph defaults and explicit original-detail expansion', async t => {
  const { root, layout } = fixture(t);
  await buildWorldModel({ root });
  const before = originals(root, layout);
  const compact = await call('head_project_graph', { project_root: root, query: 'queue' });
  const cliCompact = await runCommand(['graph-query', root, '--query', 'queue']);
  assert.equal(compact.resultId, cliCompact.resultId);
  assert.deepEqual(compact.nodes, cliCompact.nodes);
  assert.equal(compact.query.maxNodes, 8);
  assert.equal(compact.query.maxEdges, 12);
  assert.equal(compact.query.details, false);
  assert(compact.nodes.length > 0);
  const anchor = compact.nodes[0].nodeId;
  const detail = await call('head_project_graph', { project_root: root, anchor_ids: [anchor], details: true });
  const cliDetail = await runCommand(['graph-query', root, '--anchors', anchor, '--details']);
  assert.equal(detail.resultId, cliDetail.resultId);
  assert.deepEqual(detail.nodes, cliDetail.nodes);
  assert.equal(detail.query.maxNodes, 60);
  assert.equal(detail.query.maxEdges, 120);
  assert.equal(detail.query.details, true);
  assert(detail.nodes.some(node => node.nodeId === anchor));
  assert.equal(detail.authority.recoveryAuthority, false);
  assert.deepEqual(originals(root, layout), before);
});
