async function test() {
  const llmWrapper = {
    chat: async function(params, ...args) {
      console.log('called chat', params);
      return (async function* () {
        yield { choices: [{ delta: { content: 'hello' } }] };
      })();
    }
  }
  const stream = await llmWrapper.chat({ prompt: 'test' });
  for await (const chunk of stream) {
    console.log(chunk);
  }
}
test();
