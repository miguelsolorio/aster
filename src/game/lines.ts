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
  /** Said once, at a camp fire after dark, to someone with a board and nothing to sleep on: the bedroll. */
  bedroll: [
    'Out this late, with nothing to lie on?',
    'Take a roll. We carry more than we have backs for.',
    {
      keys: 'Press B to lay it out on open ground. Press B beside it to sleep until dawn or dusk.',
      touch: 'Tap Tools, then the bedroll, to lay it out on open ground. Tap it again beside it to sleep until dawn or dusk.',
    },
    'It stays where you leave it. Lay it somewhere new and the old place is given up.',
  ] as Line[],
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
  /** To someone with no star chart who has not yet found a sundial: mixed in with the rest. */
  dial: ['There are sundials out in the sand, older than the avenue. Find one, then come and tell me.'],
  /** Said once, to someone who has found a sundial: the star chart. */
  gift: [
    'You\'ve stood at one of the old dials. It shows in how you look at shadows.',
    'The dials are for the day. This is for the night. Take it. I know it by heart.',
    'After dark, look up. One line of stars burns brighter than the rest. Something you haven\'t seen lies under it.',
  ] as Line[],
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
  /** While this temple still has something lying on its stone: mixed in with the rest. */
  offering: ['Something is left on the stone inside. It\'s for whoever walks in. Take it.'],
  /** Said once, to anyone who comes to the temple without one: the spyglass. */
  gift: [
    'You look past the stair, out at the dunes. Most who come here don\'t.',
    'Take this. We watch for walkers with it, and there are more glasses than keepers.',
    'Hold it steady on a far place until the ring closes. A thread of light will stand there until you reach it.',
    {
      keys: 'Hold F to raise it. The wheel draws it in and out.',
      touch: 'Tap Tools, then the spyglass, to raise it. Tap it again to lower it.',
    },
  ] as Line[],
};

/** The goat herders out with their flocks. Someone who has ridden a wild animal is given the flute. */
export const HERDER = {
  /** The first time, to someone who has never ridden. */
  ask: [
    'Mind the goats. They go where I go.',
    'You walk past the wild ones as if they were rocks. Sit on one first. An ass or an oryx, it makes no difference.',
    'Then come back, and I\'ll show you how to ask them properly.',
  ] as Line[],
  /** Asked already, and still not ridden. */
  pending: 'Still on your own feet? Walk up to one slowly and climb on. They forgive it.',
  /** To someone who has ridden. */
  gift: [
    'You\'ve ridden. I can smell it on you.',
    'Here. Cut from the reeds at the spring. The goats come to it, and so will a wild one, if it\'s near enough to hear.',
    {
      keys: 'Press R to play. If nothing comes, nothing was near.',
      touch: 'Tap Tools, then the flute, to play. If nothing comes, nothing was near.',
    },
  ] as Line[],
  after: [
    'Play it badly and they still come. They\'re not critics.',
    'The goats know the way home better than I do.',
    'An oryx will carry you further. An ass will complain less.',
    'I count them every evening. The number is never the same.',
  ],
};

/** The keeper of the market stall in each city: trades the carpet for a relic. */
export const WEAVER = {
  /** The first time, to someone with no relic. */
  ask: [
    'Looking, or buying? Looking is free.',
    'The good one isn\'t on the table. It won\'t lie flat, for one thing.',
    'I\'d part with it for something old. Properly old. The kind that comes out from under the sand.',
  ] as Line[],
  /** Asked already, and still no relic. */
  pending: 'Nothing old yet? It can wait. So can I.',
  /** With a relic at the belt, asked or not. */
  gift: [
    'Now that is old. Let me see it in the light.',
    'Done. Take the carpet. It was my aunt\'s, and it never liked her either.',
    {
      keys: 'Leap, then hold Space. It carries you faster, and climbs for twice as long.',
      touch: 'Leap, then hold the button. It carries you faster, and climbs for twice as long.',
    },
  ] as Line[],
  /** To someone who came by a carpet under the sand instead. */
  own: 'You found one of your own. Then you know why mine isn\'t on the table.',
  after: [
    'Does it behave? It never did for me.',
    'Everything else on the table is for walking on.',
    'Shake it out now and then. It sulks if you don\'t.',
  ],
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
    'Somewhere out there a road of torches runs up into the snow. Villages at the top, they say.',
  ],
  /** Only to someone carrying a relic from under the sand. */
  relic: [
    'What\'s that at your belt? It\'s older than the walls here.',
    'You\'ve been under the sand. I can tell by what you carry.',
    'My grandmother kept one of those on a shelf. She never said where it came from.',
    'Don\'t sell that. Whatever they offer.',
  ],
  /** In any city, to someone with no pick: points at the miner. {way} and {far} are worked out from the speaker to the miner. */
  noPick: [
    'The miner has lost a lamp and won\'t stop talking about it. Sits {way} of here, {far}. Go and listen, if you\'ve the patience.',
    'Looking for something to do? Ask the miner. Sits by a pick all day, sorting stones. {way} of here, {far}.',
    'You want the miner? {way}, {far}. Follow the lanes and look for the bright clothes.',
  ],
  /** Same, when the miner can't be placed in this city. */
  noPickBlind: [
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
 * The miners: there are several in every city, in loud colours, each sat beside a spare pick. A lamp has been left
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
  /** After any of the three: once asked, a lamp stands by the pool of every fall in the mountains. */
  anyFall: 'Or try any fall in the mountains. I\'ve worked them all, and left a lamp by every pool.',
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
  /** Afterwards, to someone with no carpet: one waits at the heart of every room under the sand. */
  carpet: ['Something hangs in the air at the bottom of those rooms. Cloth, I think. I left it alone.'],
  /** Afterwards, to someone who has not swung the pick yet and has no rod. */
  rodAsk: 'Swing that pick somewhere first. Then come back. I\'ve something that saves the arm.',
  /** Afterwards, once the pick has been swung: the dowsing rod. */
  rod: [
    'You\'ve been swinging. There\'s sand in the pick\'s eye.',
    'Hitting and listening is the slow way. Take this. I cut it from a tree that grew over a well.',
    'Carry it on foot. When the fork pulls down, there\'s a room near. The harder it pulls, the closer you stand.',
  ] as Line[],
};

/** Said over the lit sand above a sealed room, to whoever walks onto it. */
export const SAND = {
  /** To someone with nothing to dig with. */
  noPick: 'Light comes up through the cracks. There\'s a room under this sand. A pick would break it open, and the miners in the cities keep spares.',
  /** To someone with a pick who has not opened a room yet. */
  dig: {
    keys: 'Light comes up through the cracks. There\'s a room under this sand. Press E to strike it, and keep on until it gives.',
    touch: 'Light comes up through the cracks. There\'s a room under this sand. Tap the pick button to strike it, and keep on until it gives.',
  } as Line,
  /** To someone who has opened one before: one of these. */
  again: [
    'The cracks are lit here too. Another room, a few swings down.',
    'More light under the sand. It wants the pick.',
    'This sand is thin. Something waits under it.',
  ],
};

/** Said over a thing picked up where it lay: what it is, and how it is used. */
export const FOUND: Record<'chart' | 'flute' | 'bedroll' | 'rod' | 'rope' | 'carpet', Line> = {
  chart: 'A star chart. After dark, the brightest line of stars stands over something you haven\'t seen.',
  flute: {
    keys: 'A reed flute. Press R to play. A wild one comes, if it\'s near enough to hear.',
    touch: 'A reed flute. Tap Tools, then the flute, to play. A wild one comes, if it\'s near enough to hear.',
  },
  bedroll: {
    keys: 'A bedroll. Press B to lay it on open ground. Press B beside it to sleep.',
    touch: 'A bedroll. Tap Tools, then the bedroll, to lay it on open ground. Tap it again beside it to sleep.',
  },
  rod: 'A dowsing rod. Carry it on foot. The fork pulls down when there\'s a room under the sand.',
  rope: 'A rope and a hook. Rock too steep to walk can be climbed now.',
  carpet: {
    keys: 'A carpet that won\'t lie flat. Leap, then hold Space. It flies faster, and climbs for twice as long.',
    touch: 'A carpet that won\'t lie flat. Leap, then hold the button. It flies faster, and climbs for twice as long.',
  },
};
