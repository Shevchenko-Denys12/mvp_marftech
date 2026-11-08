// Офлайн-провайдер без моделі: віддає шаблонні варіанти в тому самому JSON-форматі.
// Потрібен, щоб утиліту можна було запустити й показати без API-ключа і щоб тести
// не залежали від мережі. У першій спробі він навмисно додає по одному
// «поганому» кандидату на тип, щоб було видно, як працюють фільтри harness.

const BANK = {
  hook: [
    ['Where does the other sock actually go?', 'curiosity gap'],
    ['I have not matched socks in months.', 'relatable moment'],
    ['Stop pairing your socks. Let magnets do it.', 'benefit-first'],
    ["Your washer isn't eating your socks. They're just lonely.", 'light humor'],
    ['Sock roulette ends today.', 'light humor'],
    ['One tiny magnet changed my laundry day.', 'mini story'],
    ['Matching socks should not be a chore.', 'myth-busting'],
    ['Ever dug through the dryer for one sock?', 'direct question'],
    ['The sock drawer problem nobody talks about.', 'curiosity gap'],
    ['Lost socks are optional now.', 'contrarian take'],
    ['Why do socks vanish in the wash?', 'direct question'],
    ['Meet the socks that stay together.', 'benefit-first']
  ],
  first_line: [
    ['Every laundry day ends the same way, with one sock and zero matches.', 'relatable moment'],
    ['SockLock socks have a small magnet in the cuff, so each pair stays together.', 'benefit-first'],
    ['I used to keep a drawer of orphan socks, just in case.', 'mini story'],
    ['Here is the simple fix I wish I had found years ago.', 'mini story'],
    ['If you have ever lost a sock in the wash, this one is for you.', 'direct question'],
    ['Instead of hunting for matches, you just grab a pair and go.', 'benefit-first'],
    ['The trick is a tiny magnet that keeps both socks together in the wash.', 'curiosity gap'],
    ['Laundry feels different when every sock already has its partner.', 'relatable moment'],
    ['Most people accept lost socks as normal, but you do not have to.', 'myth-busting'],
    ['Five pairs are $29, and a new set arrives every quarter.', 'benefit-first']
  ],
  on_screen: [
    ['No more lost socks', 'benefit-first'],
    ['Magnet in every cuff', 'curiosity gap'],
    ['Pairs stay together', 'benefit-first'],
    ['5 pairs for $29', 'benefit-first'],
    ['New socks every quarter', 'benefit-first'],
    ['Sock roulette: over', 'light humor'],
    ['Wash. Dry. Still a pair.', 'light humor'],
    ['Say goodbye to orphan socks', 'contrarian take'],
    ['Where did that sock go?', 'direct question'],
    ['Laundry day, simplified', 'relatable moment'],
    ['Tap to try SockLock', 'benefit-first'],
    ['The sock that stays', 'curiosity gap']
  ]
};

// Кандидати, які правила мають відхилити (див. config/rules.json).
const FLAWED = {
  hook: ['Guaranteed: you will never lose a sock again', 'benefit-first'],
  first_line: [
    'SockLock is the number one rated sock brand in America, according to thousands of happy customers who all reviewed them online.',
    'bold claim'
  ],
  on_screen: ['50% off today only', 'benefit-first']
};

const KEY = { hook: 'hooks', first_line: 'first_lines', on_screen: 'on_screen_texts' };

function seedFrom(text) {
  let h = 0;
  for (const ch of text) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return h;
}

export class MockProvider {
  constructor() {
    this.label = 'mock';
    this.models = ['templates'];
  }

  async complete({ meta = {} }) {
    const need = meta.need ?? { hook: 5, first_line: 5, on_screen: 5 };
    const attempt = meta.attempt ?? 1;
    const seed = seedFrom(meta.script ?? '') + attempt * 5;

    const out = {
      analysis: {
        pain: 'Odd socks disappearing in the wash',
        emotion: 'Everyday laundry frustration',
        hook_type: 'Relatable problem',
        angle: 'A magnet keeps each pair together',
        cta: 'Tap to try SockLock'
      }
    };

    for (const type of Object.keys(KEY)) {
      const n = need[type] ?? 0;
      const bank = BANK[type];
      const withFlaw = attempt === 1 && n > 0;
      const good = withFlaw ? n - 1 : n;
      const items = [];
      for (let i = 0; i < good; i++) {
        const [text, angle] = bank[(seed + i) % bank.length];
        items.push({ text, angle });
      }
      // «Поганий» кандидат ставимо першим, щоб harness гарантовано його перевірив.
      if (withFlaw) items.unshift({ text: FLAWED[type][0], angle: FLAWED[type][1] });
      out[KEY[type]] = items;
    }

    return {
      text: JSON.stringify(out),
      model: 'templates',
      usage: { promptTokens: 0, completionTokens: 0 }
    };
  }
}
