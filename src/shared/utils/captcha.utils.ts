const CAPTCHA_EMOJIS: { emoji: string; key: string }[] = [
  { emoji: '🐳', key: 'whale' },
  { emoji: '🐍', key: 'snake' },
  { emoji: '🐝', key: 'bee' },
  { emoji: '🪱', key: 'worm' },
  { emoji: '🦋', key: 'butterfly' },
  { emoji: '🦉', key: 'owl' },
  { emoji: '🦆', key: 'duck' },
  { emoji: '🐶', key: 'dog' },
  { emoji: '🐰', key: 'rabbit' },
  { emoji: '🐸', key: 'frog' },
  { emoji: '🐌', key: 'snail' },
  { emoji: '🐈', key: 'cat' },
  { emoji: '🎄', key: 'tree' },
  { emoji: '🍄', key: 'mushroom' },
  { emoji: '🌹', key: 'rose' },
  { emoji: '🔥', key: 'fire' },
  { emoji: '🍎', key: 'apple' },
  { emoji: '🍌', key: 'banana' },
  { emoji: '🍋', key: 'lemon' },
  { emoji: '🍆', key: 'eggplant' },
  { emoji: '🍔', key: 'burger' },
  { emoji: '⚽️', key: 'soccer' },
  { emoji: '🏀', key: 'basketball' },
  { emoji: '🎤', key: 'mic' },
  { emoji: '✈️', key: 'plane' },
  { emoji: '🚀', key: 'rocket' },
  { emoji: '🚗', key: 'car' },
  { emoji: '💌', key: 'letter' },
  { emoji: '❤️', key: 'heart' },
  { emoji: '🥕', key: 'carrot' },
  { emoji: '⛄️', key: 'snowman' },
  { emoji: '☀️', key: 'sun' },
  { emoji: '💍', key: 'ring' },
  { emoji: '👜', key: 'bag' },
  { emoji: '👓', key: 'glasses' },
  { emoji: '👁️', key: 'eye' },
  { emoji: '👂', key: 'ear' },
  { emoji: '💄', key: 'lipstick' },
];

export function generateCaptcha(): {
  correctKey: string;
  options: { emoji: string; key: string }[];
} {
  const shuffled = [...CAPTCHA_EMOJIS].sort(() => Math.random() - 0.5);
  const selected = shuffled.slice(0, 3);
  const correctIndex = Math.floor(Math.random() * 3);
  const correct = selected[correctIndex];
  return {
    correctKey: correct.key,
    options: selected.map((s) => ({ emoji: s.emoji, key: s.key })),
  };
}
