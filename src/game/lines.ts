// Everything anyone says. Plain strings, no logic: edit the voice here.
//
// A conversation is a list of lines stepped through one at a time. Where a line
// names a control it comes in two forms, one for keys and one for touch.

export interface KeyLine {
  keys: string;
  touch: string;
}

export type Line = string | KeyLine;

/** Travellers on the road and at their fires. Whoever you speak to first gives you the board. */
export const TRAVELLER = {
  /** Said once, to someone on foot. The last two lines are the instructions for it. */
  gift: [
    'You walked here? Across that?',
    'Nobody walks the sand. It takes all day and gives nothing back.',
    'Here. I carry a spare. It\'s old, but it still knows the dunes.',
    {
      keys: 'Lean where you want to go. Hold Shift to run with it.',
      touch: 'Lean where you want to go. Push the stick further to run with it.',
    },
    {
      keys: 'Press Q to step off and carry it. Press Q again to get back on.',
      touch: 'Tap the board button to step off and carry it. Tap it again to get back on.',
    },
  ] as Line[],
  /** One of these, to someone who already rides. */
  after: [
    'It suits you. Keep it off the rock and it\'ll last.',
    'The long faces are the fast ones. Take them at a slant.',
    'We leave at first light. The animals won\'t walk in the heat.',
    'There\'s a city past those dunes. You can see its towers from the crest.',
    'Sit if you like. The fire doesn\'t mind.',
    'Every road out here runs between two cities. Follow the markers and you won\'t be lost.',
    'I\'ve crossed this country nine times. It\'s never looked the same twice.',
    'The wind moved the ridge again last night. It does that.',
  ],
};

/** Pilgrims walking the avenues out from the temples. One line each. */
export const PILGRIM = {
  any: [
    'We walk to the temple and back. That\'s the whole of it.',
    'My feet know this avenue better than my own street.',
    'Kneel at the stair if you like. Nobody asks why.',
    'The keepers say the stones were here before the sand. I believe them.',
    'Walk with us a while. It goes quicker with company.',
    'Leave something by the door. A jar, a stone. It doesn\'t matter what.',
    'I came to ask the temple a question. I\'ve forgotten what it was.',
  ],
  night: [
    'The braziers are lit. You can see them from the next dune.',
    'We carry our own light. The temple keeps the rest.',
    'The stones hold the day\'s heat. Put your hand on one.',
  ],
};

/** The keepers who tend each temple, by the door and at the foot of the stair. One line each. */
export const KEEPER = {
  any: [
    'Welcome. Mind the step. It\'s worn in the middle.',
    'We sweep the avenue every morning. By evening the sand is back.',
    'The flame inside hasn\'t gone out in my lifetime. Or my teacher\'s.',
    'Pilgrims come from every city. They all leave a jar by the door.',
    'Go in if you want. It\'s the coolest room for a day\'s walk.',
    'The carvings were sharp once. The wind is patient.',
  ],
  night: [
    'We light the braziers at dusk, so the walkers can find their way back.',
    'Late to be out. Stand by the fire a while.',
  ],
  /** Only to someone carrying a relic from under the sand. */
  relic: ['What you carry came from under the sand. So did we, if you go back far enough.'],
};

/** People in the cities. One line each, drawn from these pools. */
export const TOWNSFOLK = {
  /** Said by anyone, anywhere. */
  any: [
    'There\'s sand in your hood.',
    'Passing through? Most are.',
    'Mind the children. They follow strangers.',
    'The well is sweet this year.',
    'You look like you\'ve come a long way.',
    'Stay for the lamps. The streets are better after dark.',
    'My mother said never to trust a quiet wind.',
    'If you\'re looking for someone, ask at the square.',
  ],
  /** Only to someone carrying a relic from under the sand. */
  relic: [
    'What\'s that at your belt? It\'s older than the walls here.',
    'You\'ve been under the sand. I can tell by what you carry.',
    'My grandmother kept one of those on a shelf. She never said where it came from.',
    'Don\'t sell that. Whatever they offer.',
  ],
  /** In any city, to someone with no pick: points at the miner. */
  noPick: [
    'The miner has lost a lamp and won\'t stop talking about it. Go and listen, if you\'ve the patience.',
    'Looking for something to do? Ask the miner. Sits by a pick all day, sorting stones.',
  ],
  /** Only to someone still on foot: points at the people who can help. */
  onFoot: [
    'You came on foot? The travellers outside the walls ride the sand. Ask one of them.',
    'No board? Find a caravan fire. They always carry a spare.',
    'Walking is for streets. Out there you want something under your feet.',
  ],
  hill: [
    'Climb to the top terrace. You can see three days in every direction.',
    'The stairs keep us young. Or they kill us. One of the two.',
    'Snow on the far peaks this morning. It never reaches us.',
    'From up here the caravans look like ants carrying crumbs.',
  ],
  canyon: [
    'The walls keep the sun off until noon. After that, find a doorway.',
    'Listen. The canyon answers if you call into it.',
    'The rock here is older than the river that cut it.',
    'We build down, not up. It\'s cooler the deeper you go.',
  ],
  oasis: [
    'Wade in. Nobody minds.',
    'The palms were here before the houses.',
    'The water comes up from somewhere under the dunes. Nobody has found where.',
    'Birds stop here on their way across. So does everyone else.',
  ],
  trade: [
    'Everything on this pan came from somewhere else. So did I.',
    'The salt is flat for a day in every direction. You can see the caravans coming.',
    'Buy nothing before noon. The prices are for the tired.',
    'Three roads meet here. That\'s the whole reason for the place.',
  ],
  dawn: [
    'Up early. The bread isn\'t ready.',
    'The light comes over the wall and the whole street turns gold.',
    'First light is the only cool hour. Use it.',
  ],
  noon: [
    'Too hot to stand in the open. Come under the awning.',
    'Nothing moves at this hour but flies and fools.',
  ],
  dusk: [
    'The lamps will be lit soon.',
    'This is the hour the sand turns red.',
    'The caravans come in before dark. Listen for the bells.',
  ],
  night: [
    'Late to be walking. The gate stays open, though.',
    'Look up. You won\'t see that many stars from anywhere else.',
    'The fires out on the sand are travellers. They\'re friendly enough.',
  ],
};

/**
 * The miner: there is one in every city, sat beside a spare pick. A lamp has been left
 * out in the desert; whoever brings it back is given the pick.
 *
 * Where a line says where something is, {way} is a compass direction ("north-east") and {far}
 * a rough distance ("a long walk"), both worked out from where it really lies.
 */
export const MINER = {
  /** The first time, to someone without the lamp. One of the three `lamp` lines follows, then `askEnd`. */
  ask: [
    'Mind the heap. It\'s sorted.',
    'You look like someone who wanders. I could use a wanderer.',
    'I left my lamp out there, and I can\'t read a seam without it.',
  ] as Line[],
  /** Where the lamp is, by what it was left beside. At a spring there are two: one on the pool's bank, one up in the cave mouth. */
  lampSpring: 'I had two, and left both at the spring under the mountain to the {way}, {far}. One is by the pool. The other is up in the mouth the water falls from. Either will do.',
  lampCave: 'It\'s in the cave on the mountain to the {way}, {far}. Just inside the mouth.',
  lampSand: 'It\'s out on the sand to the {way}, {far}. It\'ll be the only light out there.',
  askEnd: 'Bring it back and I\'ll make it worth the walk.',
  /** Asked already, and still no lamp. The `lamp` line follows again. */
  pending: 'No lamp? It won\'t have walked off.',
  /** With the lamp in hand, whether or not it was asked for. The last line is `cavern` or `noCavern`. */
  gift: [
    'That\'s the one. Still dented where I dropped it.',
    'Fair is fair. Take the spare pick. It\'s better balanced than it looks.',
    'The sand is hollow in places. Strike it and listen. A thud is nothing. A ring means there\'s a room under you, and it rings longer the closer you stand.',
  ] as Line[],
  /** The last thing said with the gift: how to swing it, and the nearest place worth swinging it. */
  cavern: {
    keys: 'There\'s one to the {way}, {far}. Find the dip where the sand drifts slow, and press E until it gives. E swings it whenever there\'s nobody to talk to.',
    touch: 'There\'s one to the {way}, {far}. Find the dip where the sand drifts slow, and tap the pick button until it gives. The button swings it whenever there\'s nobody to talk to.',
  } as Line,
  noCavern: {
    keys: 'Press E to swing it, whenever there\'s nobody to talk to. Try the open sand, well away from any town.',
    touch: 'Tap the pick button to swing it, whenever there\'s nobody to talk to. Try the open sand, well away from any town.',
  } as Line,
  /** Afterwards, while there is still a sealed cavern to point at. */
  remind: 'Not found it? To the {way}, {far}. A dip where the sand drifts slow.',
  /** Afterwards, one of these. */
  after: [
    'Sand is only rock that gave up. Hit it enough and it tells you what\'s under it.',
    'If it rings, keep at it.',
    'I\'d come with you, but someone has to mind the heap.',
    'The lamp burns better for the walk. Don\'t ask me why.',
  ],
  /** Afterwards, to someone carrying a relic. */
  relic: ['That thing on your belt is older than this city. Keep it dry.'],
};
