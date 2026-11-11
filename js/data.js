// Cars, tracks and lighting themes. Speeds are in m/s, distances in metres.
export const LAPS = 3;

export const CARS = [
  { id: 'sedan-sports', name: 'Спортен седан', top: 58, acc: 23, grip: 1.0, note: 'Балансиран във всичко' },
  { id: 'hatchback-sports', name: 'Хечбек', top: 54, acc: 26, grip: 1.15, note: 'Пъргав в завоите' },
  { id: 'race', name: 'Болид', top: 66, acc: 25, grip: 1.05, note: 'Най-бърз на правата' },
  { id: 'race-future', name: 'Прототип', top: 63, acc: 29, grip: 0.92, note: 'Рязко ускорение, хлъзга се' },
  { id: 'suv-luxury', name: 'Джип', top: 52, acc: 21, grip: 1.25, note: 'Стабилен и на тревата' },
  { id: 'police', name: 'Патрулка', top: 57, acc: 24, grip: 1.08, note: 'Здрава и послушна' },
  { id: 'taxi', name: 'Такси', top: 55, acc: 22, grip: 1.05, note: '', aiOnly: true }
];

export const RIVALS = ['Гошо', 'Ива', 'Марто', 'Деси', 'Боби'];

export const THEMES = {
  morning: {
    zen: 0x2f7fd6, hor: 0xc4e6f7, sunDir: [0.5, 0.72, 0.3], sunCol: 0xfff2d6, sun: 2.6,
    hemiSky: 0xd6ecff, hemiGround: 0x52663e, hemi: 1.25,
    grass: 0x63a548, forest: 0x2f6e3c, rock: 0x8d9299, sand: 0xcfbd8c, water: 0x2f86bd, fog: [220, 1200]
  },
  sunset: {
    zen: 0x3a4c98, hor: 0xffb47e, sunDir: [-0.72, 0.3, 0.45], sunCol: 0xffb273, sun: 2.9,
    hemiSky: 0xffd2b2, hemiGround: 0x4d3c3a, hemi: 1.0,
    grass: 0x86a047, forest: 0x44683a, rock: 0x9c8c86, sand: 0xd6b685, water: 0x55739f, fog: [180, 1000]
  },
  dusk: {
    zen: 0x151e4c, hor: 0x7a74b4, sunDir: [0.3, 0.42, -0.8], sunCol: 0xbcc4ff, sun: 2.0,
    hemiSky: 0x99a4ff, hemiGround: 0x20263f, hemi: 1.2,
    grass: 0x41805e, forest: 0x215044, rock: 0x747c93, sand: 0x9c9ca4, water: 0x25437d, fog: [160, 900]
  },
  // The themes below also use: weather ('snow' | 'rain'), night (headlights, moonlight), stars, lamps (a street lamp
  // every N track samples), treeTint ([colour, amount]) and road ({ color, wet, shine } for js/track.js).
  snow: {
    zen: 0x7f98b8, hor: 0xdce4ec, sunDir: [0.35, 0.62, -0.55], sunCol: 0xfff6ea, sun: 1.7,
    hemiSky: 0xeef4ff, hemiGround: 0xa7b3c2, hemi: 1.15,
    grass: 0xe6edf3, forest: 0xc9d5de, rock: 0x8b929c, sand: 0xc4ccd4, water: 0x9bb8cf, fog: [120, 820],
    weather: 'snow', treeTint: [0xeef3f7, 0.62], road: { color: 0xd6dce4 }
  },
  night: {
    zen: 0x03060f, hor: 0x1a2440, sunDir: [-0.45, 0.55, 0.62], sunCol: 0x9fb4ff, sun: 0.6,
    hemiSky: 0x7084bd, hemiGround: 0x232a3e, hemi: 1.35,
    grass: 0x3a5c40, forest: 0x1d3a2a, rock: 0x5c6270, sand: 0x7a7a80, water: 0x18284a, fog: [70, 520],
    night: true, stars: true, lamps: 24, road: { color: 0xe6e8f0 }
  },
  rain: {
    zen: 0x4c5865, hor: 0x8b96a0, sunDir: [0.25, 0.42, 0.87], sunCol: 0xb4bcc4, sun: 1.0,
    hemiSky: 0xc6d0da, hemiGround: 0x3e4a3c, hemi: 1.5,
    grass: 0x4f7a42, forest: 0x2b4f36, rock: 0x6f7780, sand: 0x9a957f, water: 0x45606f, fog: [28, 330],
    weather: 'rain', road: { color: 0x9da3ab, wet: true, shine: 40 }
  }
};

export const TRACKS = [
  {
    id: 'dospat', name: 'Язовир Доспат', sub: 'Утро, плавни завои', theme: 'morning',
    pts: [[0, 0], [120, -10], [220, 40], [260, 140], [200, 220], [100, 200], [40, 260], [-80, 280], [-180, 220], [-200, 110], [-120, 60], [-80, -20]]
  },
  {
    id: 'velingrad', name: 'Велинград', sub: 'Залез, техничен', theme: 'sunset',
    pts: [[0, 0], [140, 0], [230, -50], [300, 10], [280, 110], [180, 130], [150, 210], [230, 290], [160, 360], [40, 330], [20, 230], [-60, 180], [-160, 230], [-240, 160], [-200, 50], [-100, 30]]
  },
  {
    id: 'sarnitsa', name: 'Сърница', sub: 'Привечер, дълъг и бърз', theme: 'dusk',
    pts: [[0, 0], [200, -20], [340, 60], [360, 200], [260, 280], [140, 240], [60, 300], [80, 420], [-40, 480], [-160, 420], [-140, 300], [-240, 220], [-260, 80], [-140, 20]]
  },
  // New tracks go after the first three: their ids and points are used by the online server and the records.
  {
    id: 'perelik', name: 'Перелик', sub: 'Сняг, хлъзгави серпентини', theme: 'snow', grip: 0.85,
    pts: [[0, 0], [170, 0], [250, 20], [270, 70], [220, 110], [110, 100], [10, 120], [-30, 175], [30, 220], [150, 210], [260, 230], [290, 290], [230, 340], [100, 335], [-30, 345], [-140, 320], [-200, 240], [-190, 140], [-190, 50], [-110, 0]]
  },
  {
    id: 'beglika', name: 'Беглика', sub: 'Нощ, на фарове и фенери', theme: 'night',
    pts: [[0, 0], [150, 0], [300, -20], [420, -60], [520, -20], [540, 80], [460, 140], [340, 120], [220, 160], [100, 130], [-20, 170], [-140, 150], [-220, 90], [-200, 0], [-110, -10]]
  },
  {
    id: 'shiroka-polyana', name: 'Широка поляна', sub: 'Дъжд и мъгла, мокър асфалт', theme: 'rain', grip: 0.88,
    pts: [[0, 0], [220, 10], [380, -40], [480, 40], [460, 180], [340, 230], [300, 330], [180, 380], [40, 330], [-80, 380], [-200, 320], [-230, 190], [-160, 110], [-190, 30], [-110, -10]]
  }
];
