// Document snapshots can contain hundreds of thousands of symbols. Advance
// their preparation in short tasks, and discard the whole unpublished result
// when an edit or a source change makes its coordinates obsolete.
exports.run = async function run(
  iterator,
  {
    signal,
    isCurrent = () => true,
    yieldTask = () => new Promise((resolve) => setImmediate(resolve)),
    sliceMillis = 4,
  } = {},
) {
  const current = () => !signal?.aborted && isCurrent();
  try {
    while (current()) {
      const deadline = performance.now() + sliceMillis;
      for (let operations = 0; operations < 2048; operations++) {
        const step = iterator.next();
        if (step.done) return current() ? step.value : null;
        if ((operations & 31) === 31 && performance.now() >= deadline) break;
      }
      await yieldTask();
    }
    return null;
  } finally {
    iterator.return?.();
  }
};

// Stable merge sort, with an inexpensive path for already ordered providers.
// Array#sort itself cannot yield, even when its comparator is cheap.
exports.sort = function* sort(symbols) {
  let sorted = true;
  for (let index = 1; index < symbols.length; index++) {
    if (symbols[index - 1].position.compare(symbols[index].position) > 0) sorted = false;
    yield;
  }
  if (sorted) return symbols;
  let source = symbols;
  let target = new Array(symbols.length);
  for (let width = 1; width < symbols.length; width *= 2) {
    for (let start = 0; start < symbols.length; start += width * 2) {
      const middle = Math.min(start + width, symbols.length);
      const end = Math.min(start + width * 2, symbols.length);
      let left = start;
      let right = middle;
      for (let index = start; index < end; index++) {
        target[index] =
          right >= end ||
          (left < middle && source[left].position.compare(source[right].position) <= 0)
            ? source[left++]
            : source[right++];
        yield;
      }
    }
    [source, target] = [target, source];
  }
  return source;
};
