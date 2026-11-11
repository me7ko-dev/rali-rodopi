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
  }
];
