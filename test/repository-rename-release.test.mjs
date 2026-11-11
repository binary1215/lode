import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('repository rename preserves installed carrier identity and pins only exact old marketplace predecessors', () => {
  const workflow = fs.readFileSync(new URL('../.github/workflows/go-worker-build-release.yml', import.meta.url), 'utf8');
  const predecessors = ['d0b9b6bee9e6aaed5c76de1c881520067d61e985', 'd22c0e04a8bcaf83814f452fb69ae99a13de8f0a'];
  for (const sha of predecessors) {
    assert(workflow.includes(`if [[ "\${MARKETPLACE_NAME}" == "head-agent-plugin" && "\${GITHUB_REPOSITORY}" == "binary1215/lode" && "\${expected_sha}" == "${sha}" ]]; then\n              previous_repository="binary1215/head-agent-plugin"\n            fi`));
  }
  assert.equal((workflow.match(/previous_repository="\$\{GITHUB_REPOSITORY\}"/g) ?? []).length, 2);
  assert.equal((workflow.match(/--source-repository "\$\{GITHUB_REPOSITORY\}"/g) ?? []).length, 2);
  // Count builder argument lines, not the read-only publication verifier's inline option.
  assert.equal((workflow.match(/^ +--marketplace-name "\$\{MARKETPLACE_NAME\}"/gm) ?? []).length, 2);
  assert.equal((workflow.match(/marketplace_name: head-agent-plugin/g) ?? []).length, 2);
  assert.equal((workflow.match(/if \[\[ "\$\{MARKETPLACE_NAME\}" != "head-agent-plugin" \]\]; then exit 1; fi/g) ?? []).length, 2);
  assert.equal((workflow.match(/--expected-repository "\$\{previous_repository\}"/g) ?? []).length, 5);
  assert.equal((workflow.match(/--force-with-lease="refs\/heads\/\$\{MARKETPLACE_BRANCH\}:\$\{EXPECTED_SHA\}"/g) ?? []).length, 2);
  assert(!workflow.includes('--force origin'));
  // This is a workflow contract check, not an actual installation/update test.
  // Wording pinned: these are the published marketplace refs and plugin ids users
  // type to install or update; they must match the marketplace branches.
  for (const file of ['../README.md', '../README.ko.md']) {
    const readme = fs.readFileSync(new URL(file, import.meta.url), 'utf8');
    assert(readme.includes('binary1215/lode --ref lode-codex-marketplace'));
    assert(readme.includes('binary1215/lode@lode-claude-marketplace'));
    assert(readme.includes('lode-agent-core@lode-agent-plugin'));
    assert(readme.includes('head-agent-core@head-agent-plugin'));
    assert(readme.includes('codex plugin marketplace upgrade head-agent-plugin'));
    assert(readme.includes('claude plugin update head-agent-core@head-agent-plugin'));
  }
});
