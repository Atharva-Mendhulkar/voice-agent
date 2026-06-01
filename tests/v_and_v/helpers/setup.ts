// Mocks are imported directly in the tests that need them.

// Hook into vitest setup/teardown if harness exports it (dummy if not)
if (typeof setupHarness === 'function') {
  setupHarness();
}
