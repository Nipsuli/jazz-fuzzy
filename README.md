# Playing around with Jazz and (fuzzy) indexing

Part of learning experience about information retrieval. I'm testing different
ways to construct indexes on top of CRDT data structures using
[Jazz](https://jazz.tools/) as my storage engine.

Currently implemented Fuzzy search. Thinking on testing other type of indices as
well, like phrase matching and ANN vector indices. And also improve the fuzzy
search to utilize the position to boost results.

## run

```bash
pnpm install
```

Fill in the `.env` with Jazz api key from Jazz dashboard and create worker with:

```bash
npx jazz-run account create --name "My Index Worker"
```

Run the dummy example. The data was generated with quickly with LLM. TODO: find
some good fuzzy search dataset to test against

```bash
node --experimental-transform-types src/index.ts
```

## Notes

For fuzzy index I'm using the ngram sorting trick from
[this fuzzy search](https://github.com/m31coding/fuzzy-search) package.
