const CLUSTERS = ["gr", "kr", "sn", "sk", "bl", "zg"];
const CONSONANTS = ["p", "b", "t", "d", "k", "g", "m", "n", "s", "z", "r", "l"];
const VOWELS_SHARP = ["i", "e"];
const VOWELS_DULL = ["a", "o", "u"];
const CODAS = ["n", "k", "b", "z", "l", "", ""];

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function generateName(): string {
  const vowels = Math.random() < 0.7 ? VOWELS_DULL : VOWELS_SHARP;

  function syllable(): string {
    const onset = pick([pick(CONSONANTS), pick(CLUSTERS), ""]);
    return onset + pick(vowels) + pick(CODAS);
  }

  let name = syllable() + syllable();
  if (Math.random() < 0.15) name += syllable();
  return name.charAt(0).toUpperCase() + name.slice(1);
}

export function createNamePool() {
  const used = new Set<string>();
  let counter = 0;

  return {
    allocate(): string {
      for (let i = 0; i < 50; i++) {
        const name = generateName();
        if (!used.has(name)) {
          used.add(name);
          return name;
        }
      }
      return `imp-${++counter}`;
    },
    release(name: string) {
      used.delete(name);
    },
  };
}
