// Everything anyone says. Plain strings, no logic: edit the voice here.
//
// A conversation is a list of lines stepped through one at a time. Where a line
// names a control it comes in two forms, one for keys and one for touch.

import type { SettlementKind } from '../world/settlementKinds';

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
      keys: 'Lean where you want to go, and it runs.',
      touch: 'Lean where you want to go, and it runs.',
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
      keys: 'Leap, then hold Space. It carries you faster, and climbs twice as long and far higher.',
      touch: 'Leap, then hold the button. It carries you faster, and climbs twice as long and far higher.',
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
    'There are villages under the mountains. They don\'t come down much. Go up and talk to them.',
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

/** The people of the villages at the foot of the mountains. One line each. */
export const VILLAGER = {
  any: [
    'You came up from the sand? Sit. Nobody hurries here.',
    'The mountain keeps the wind off us. Most days.',
    'The goats are ours. The oryx belong to nobody.',
    'Water comes down off the rock. We only have to catch it.',
    'The terraces were my grandmother\'s. I just put the stones back.',
    'We see the caravans from up here, a day before they see us.',
    'Mind the bunting. The children hung it, and they\'re proud of it.',
    'There\'s a lantern on the summit. Somebody carries the oil up. Not me.',
    'Somewhere a road of torches climbs into the snow. Our cousins live at the top of it.',
  ],
  /** To someone with no rope: who to ask. */
  askWatcher: ['Ask the watcher what\'s out on the sand. Stands under the tower all day, in blue, looking.'],
  /** To someone without the boots or the feather: who to ask. */
  askClimber: ['The old climber by the fire, in green, has been to the top more times than anyone. Ask, if you\'ve an hour.'],
  dawn: ['The sun reaches the top of the mountain first. We get it an hour later.', 'Up before the goats. That\'s rare.'],
  dusk: ['The mountain\'s shadow goes out across the sand at this hour. Watch it.', 'The fire in the square is lit. Sit by it.'],
  night: [
    'You can see every camp on the sand from here, once it\'s dark.',
    'The fire in the square burns till morning. Nobody remembers who decided that.',
    'Late to be on the mountain. Stay by the fire.',
  ],
  /** To someone wearing the climber's boots, or the feather. */
  boots: ['Those are the climber\'s old boots. I\'d know those nails anywhere.'],
  feather: ['A feather from the top. Then you\'ve been higher than any of us.'],
  /** The children. */
  child: [
    'Did you fly here? I saw someone fly once.',
    'I\'m not allowed past the last terrace.',
    'The goats have names. I\'m not telling you them.',
    'When I\'m bigger I\'m going to the top.',
    'There are bones out on the sand as big as a house. The watcher said.',
  ],
};

/** The people of the villages up the torchlit road, in the snow. One line each. */
export const SNOWFOLK = {
  any: [
    'Come in by the fire. You\'re dressed for sand.',
    'The torches brought you? We light them for exactly that.',
    'Snow keeps. What fell in winter is still here in summer.',
    'Down there they count wells. Up here we count woodpiles.',
    'Three villages on the road. This one is the best. Ask anyone here.',
    'There\'s a hold at the top with a fire you can see from the desert.',
    'The pines were planted by the first people up the road. Or the pines planted us.',
  ],
  /** There is no tower up here, and nobody watching the sand from it. */
  askWatcher: [] as string[],
  askClimber: ['The climber sits by the fire, in green. Been everywhere on this mountain, and will tell you so.'],
  night: [
    'Cold enough for you? It gets colder.',
    'The torches stay lit all night. Somebody walks the whole road with oil.',
    'Stand closer. The fire doesn\'t charge.',
  ],
  boots: ['Nailed boots. Good. The ice won\'t have you, then.'],
  feather: ['An eagle gave you that? They give us nothing.'],
  child: ['Have you seen sand? Is it like snow?', 'I can slide from here to the gate. Nearly.', 'Your hood has sand in it. I\'ve never seen sand.'],
};

/**
 * The watcher under the tower of each foot village, in blue: looks out over the sand all day, and
 * knows where a rope was left beside the great bones. {way} and {far} are worked out from the tower to the rope.
 */
export const WATCHER = {
  /** The first time, to someone with no rope, where there are bones in sight. */
  ask: [
    'I watch the sand. Somebody has to.',
    'There are bones out there to the {way}, {far}. Bigger than this tower. On a clear day you can count the ribs.',
    'My brother went to look, and came back without his rope. Left it lying beside them. A good rope, with an iron hook.',
    'It\'s yours if you fetch it. He won\'t go back. Says the ribs creak.',
  ] as Line[],
  /** Asked already, and still no rope. */
  pending: 'The rope is by the bones, to the {way}, {far}. It\'s not the sort of thing anyone steals.',
  /** Nothing to send anyone after: one of these. */
  after: [
    'I watched you come in. You don\'t walk like the caravan people.',
    'Dust to the east means a caravan. Dust everywhere means stay indoors.',
    'From the top of the tower I can see two cities. Neither can see me.',
    'Nothing out there today but sand. That\'s how I like it.',
  ],
  /** To someone with the rope. */
  rope: ['With that hook you can go straight up the rock. We go round. It takes all morning.'],
  night: ['Count the fires on the sand. Each one is somebody\'s supper.'],
};

/**
 * The old climber by the fire of every mountain village, in green: sends the wanderer up the mountain
 * twice. First for the boots left at the back of its cave, then for a feather from its summit.
 * {way} and {far} are worked out from the fire to the place.
 */
export const CLIMBER = {
  /** To someone without the boots. */
  boots: [
    'Sit. The fire is for everyone.',
    'I climbed this mountain every year, until my knees voted against it.',
    'My boots are still in the cave, to the {way}, {far}. Right at the back, past where the daylight stops. Nailed soles. They bite the rock.',
    'Take them. Boots want walking in, and I\'ve done mine.',
  ] as Line[],
  bootsPending: 'The cave, to the {way}, {far}. Right at the back. They\'ll be stiff, but they\'ll soften.',
  /** To someone with the boots and no feather. */
  feather: [
    'Those are my boots. Good. They were doing nothing in the dark.',
    'Now the top. The eagles sit up by the lantern, to the {way}, {far}, and they leave feathers.',
    'Find one and put it in your hood. The air holds you longer with it. Don\'t ask me how. Ask the eagle.',
  ] as Line[],
  featherPending: 'The summit, to the {way}, {far}. Look near the lantern. Pale, with a dark tip.',
  /** To someone with both. */
  after: [
    'Boots for going up, a feather for coming down. That\'s all I ever needed.',
    'You\'ve been to the top. It shows. People come down quieter.',
    'My knees know when the weather will turn. They\'re wrong about half the time.',
    'Step off the summit at first light. The air is still asleep, and you go for miles.',
  ],
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
export const FOUND: Record<'chart' | 'flute' | 'bedroll' | 'rod' | 'rope' | 'carpet' | 'boots' | 'feather', Line> = {
  boots: 'Nailed boots. They bite the rock: on foot you cross it quicker, and steeper.',
  feather: 'An eagle\'s feather for the hood. On a glide, the air holds you longer.',
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
    keys: 'A carpet that won\'t lie flat. Leap, then hold Space. It flies faster, and climbs twice as long and far higher.',
    touch: 'A carpet that won\'t lie flat. Leap, then hold the button. It flies faster, and climbs twice as long and far higher.',
  },
};

/** What the people of one settlement out on the sand have to say. */
export interface SettledLines {
  /** Anyone, at any hour. One line each. */
  any: string[];
  night: string[];
  child: string[];
  /** Who to ask, said until the wanderer has spoken to them this visit. */
  askHost: string;
  /** The one person worth stopping for: what they say the first time. */
  host: string[];
  /** Then where something unfound lies ({way}, {far}), which goes on the map. */
  hostPoint: string;
  /** Or this, when there is nothing left to point at. */
  hostNone: string;
  /** And after that, one of these. */
  hostAfter: string[];
}

/** The settlements, by the kind of place (see world/settlementKinds.ts). */
export const SETTLED: Record<SettlementKind, SettledLines> = {
  'well-camp': {
    any: [
      'We go where the grass went. This month it went here.',
      'The tents are goat hair. They let the wind through and keep the sun out.',
      'Four tents. In spring there are six. Then somebody argues.',
      'The camels know the way to every well. We follow and take the credit.',
      'Tea? It\'s mostly sugar. That\'s the point of it.',
      'We\'ll be gone in a month. The well stays.',
    ],
    night: ['Sit closer. The fire is small on purpose.', 'The camels sleep facing home. Nobody taught them.'],
    child: ['That camel is mine. The bad-tempered one.', 'I can find water with a stick. Nearly.'],
    askHost: 'Ask the well keeper, in white. Knows every well between here and the salt.',
    host: ['Drink first. Then talk.', 'I keep the well. It was here before the tents, and it will be here after them.', 'I know this sand by its water. Where there is water, there is something else.'],
    hostPoint: 'Go {way}, {far}. There is something there worth the walk. I\'ve marked it for you.',
    hostNone: 'You\'ve seen everything I know of. Sit and tell me about it.',
    hostAfter: ['The rope is forty arms long. The water is at thirty-eight.', 'A well is a promise somebody made a long time ago.', 'Fill your skin before you go. Nobody leaves here thirsty.'],
  },
  'star-house': {
    any: [
      'We sleep by day. You\'ve caught us at a bad hour, whatever hour it is.',
      'The hill is the only reason we\'re here. Nothing between us and the sky.',
      'No lamps past the door. House rule.',
      'The brass ring up there took nine years to make. It\'s still a little out.',
      'I\'ve been counting the same patch of sky since I was twelve.',
      'The cities are too bright. You can\'t see anything from a city.',
    ],
    night: ['Shh. Look up. No, further left.', 'That one isn\'t a star. It moves. We don\'t know what it is.'],
    child: ['I\'m allowed to carry the lenses. Not the big one.', 'I found a star. They said it had been found.'],
    askHost: 'The old stargazer, in gold, knows what lies under every star. Come back after dark.',
    host: ['You\'re standing in my light. No, stay. There isn\'t any.', 'Every star stands over some place on the ground. People forget that.', 'Pick one low on the sky and walk at it. You\'ll arrive somewhere.'],
    hostPoint: 'That one, low to the {way}. Under it, {far}, is something you haven\'t seen. I\'ve put it on your map.',
    hostNone: 'There\'s nothing under my stars you haven\'t walked to. I\'ll need more stars.',
    hostAfter: ['Come back at night. I\'m no use before then.', 'The sand is a bad sky. Too close to see properly.', 'I\'ve never been to any of the places I point at.'],
  },
  'salt-works': {
    any: [
      'Let the sun do the work. We only rake.',
      'The pink pools are nearly ready. The green ones have a month to go.',
      'One block is a day\'s wage. Don\'t sit on it.',
      'You\'ll want to squint. Everybody does for the first year.',
      'The caravans pay in cloth. We have more cloth than we can wear.',
      'Salt gets into everything. The bread, the bed, the children.',
    ],
    night: ['The pan is brighter than the sky tonight.', 'It creaks when it cools. That\'s the salt, not ghosts. Probably.'],
    child: ['I licked the house once. It\'s true, it\'s salt.', 'You can slide on the white pool. Don\'t tell.'],
    askHost: 'Talk to the tallyman, in black. He counts everything that comes in and goes out.',
    host: ['Forty-one blocks went out. Forty were paid for.', 'I count the salt. I count the caravans. I count the days it doesn\'t rain, which is all of them.', 'Caravans talk while I count them. I know where things are.'],
    hostPoint: 'One of them spoke of something to the {way}, {far}. I wrote it down. Now it\'s on your map as well.',
    hostNone: 'I\'ve nothing written down that you haven\'t seen. I checked twice.',
    hostAfter: ['Still forty.', 'If you meet a caravan with one block too many, send it back.', 'Everything here is worth exactly its weight.'],
  },
  'glass-kilns': {
    any: [
      'Don\'t touch the racks. Or the glass. Or anything.',
      'It\'s only sand. Hot enough, everything is only sand.',
      'The pale sand melts clear. The red sand melts the colour of tea.',
      'We light them at dusk. It\'s cooler for us and it looks better.',
      'Every city window you\'ve looked through came out of that kiln.',
      'I\'ve had no eyebrows since I was fifteen.',
    ],
    night: ['Stand back from the mouth. Further. There.', 'They can see us from the mountain. We\'re somebody\'s star.'],
    child: ['I made a bead. It\'s nearly round.', 'I carry sand. Next year I carry glass.'],
    askHost: 'The kiln master, in amber, is the one to talk to. Wait till the pipe is down.',
    host: ['Mind the pipe.', 'I\'ve looked through every piece of glass we ever made. You see a long way through good glass.', 'Hold this up. No, the other way. There.'],
    hostPoint: 'To the {way}, {far}. See it? No. Well, it\'s there. I\'ve marked your map.',
    hostNone: 'Nothing out there you haven\'t found. The glass doesn\'t lie.',
    hostAfter: ['Sand, fire and breath. There\'s nothing else in it.', 'A bubble in the glass is a breath somebody took forty years ago.', 'Bring me a sand I haven\'t seen and I\'ll show you its colour.'],
  },
  ledge: {
    any: [
      'You get used to the ladders. Then you get used to nothing else.',
      'The rock keeps the sun off till noon and the wind off all year.',
      'My house is my neighbour\'s roof. We\'re polite to each other.',
      'The clay comes out of the same rock. We just move it up a little.',
      'Pots dry along the edge. Nothing has ever fallen. Almost nothing.',
      'Nobody here sleepwalks. Not twice.',
    ],
    night: ['The ladders are up for the night. You\'re down here with me.', 'You can hear the whole desert from under the rock.'],
    child: ['I can climb faster than the ladder keeper.', 'I dropped a pot once. Everybody remembers.'],
    askHost: 'The ladder keeper, in ochre, says who comes up. Ask nicely.',
    host: ['Hold the rails, not the rungs.', 'I\'ve kept the ladders thirty years. Up at dawn, down at dusk. Nobody has ever thanked a ladder.', 'From the top one you see over the rock. Further than you\'d think.'],
    hostPoint: 'There\'s something to the {way}, {far}. You can see it from the top rung. It\'s on your map now.',
    hostNone: 'There\'s nothing to see from up there that you haven\'t walked to.',
    hostAfter: ['Up is the easy way. It\'s down that people get wrong.', 'I count them up and I count them down. The numbers should match.', 'A rung went last winter. We don\'t talk about it.'],
  },
  bridge: {
    any: [
      'Left bank people and right bank people. We meet in the middle and disagree.',
      'The bridge was here before us. We just moved in.',
      'My floor is the river. You stop hearing it after a year.',
      'Fish from this side taste better. Ask anyone on this side.',
      'Don\'t lean on the rail there. Lean on it over there.',
      'When the water\'s low you can see the old piers. There was a bridge before this one.',
    ],
    night: ['The river is louder at night. Or everything else is quieter.', 'We hang a lamp at each end. For the boats, and the drunk.'],
    child: ['I can spit into the river from my bed.', 'I caught a fish as long as my arm. This arm.'],
    askHost: 'You\'ll have to see the toll keeper, in red. Nobody crosses without a word.',
    host: ['Toll.', 'Not coin. News. What\'s on the far bank, what you saw on the way. That\'s what a bridge is for.', 'I\'ll give you some back. Fair is fair.'],
    hostPoint: 'Somebody crossed last week from the {way}. Said there was something {far} from here. I\'ve marked your map.',
    hostNone: 'You\'ve seen more than anyone who crosses here. Go on. No charge.',
    hostAfter: ['Everything crosses here in the end.', 'A river is a road that doesn\'t need mending.', 'I\'ve never been to either bank for longer than a day.'],
  },
  caravanserai: {
    any: [
      'Three days from one city, three from the other. So everybody stops.',
      'The gate shuts at dark. Be on the right side of it.',
      'I\'m only here till the camels are rested. I said that a year ago.',
      'You hear every language in the yard. Mostly complaints.',
      'The stew is the same every night. That\'s why it\'s good.',
      'Don\'t play dice with the stable hands.',
    ],
    night: ['The lamp over the gate burns all night. People walk a long way toward it.', 'Listen. Forty camels, all asleep.'],
    child: ['I know all the camels. I don\'t know the people.', 'Somebody left a monkey here once. It\'s gone now.'],
    askHost: 'The innkeeper, in white, hears everything. Buy something first.',
    host: ['Bed or stable? You look like stable.', 'I don\'t travel. Everybody who does comes through my gate and tells me about it.', 'So I know the desert better than any of them.'],
    hostPoint: 'A driver was talking about something to the {way}, {far}. He wasn\'t lying. He was too tired. It\'s on your map.',
    hostNone: 'You\'ve been everywhere my guests have. You should be telling me.',
    hostAfter: ['Rumours are free. The stew isn\'t.', 'Nobody lives here. A lot of people have stayed for years.', 'Leave by the same gate. There\'s only the one.'],
  },
  'dyers-town': {
    any: [
      'Don\'t brush against anything. It\'s all wet.',
      'Red is a root. Blue is a leaf. Yellow is a flower. Purple is a secret.',
      'My hands have been this colour for twenty years.',
      'The whole hill smells of blue today. Tomorrow it\'s red.',
      'The cities send white cloth up and get the desert back.',
      'We wear undyed. You don\'t eat at your own stall.',
    ],
    night: ['The colours are all still there at night. You just have to trust them.', 'The cloth dries faster in the dark wind.'],
    child: ['I fell in the yellow. It took a month to come off.', 'Guess which vat I\'m not allowed near.'],
    askHost: 'Find the master dyer, in purple. The only one of us who wears a colour.',
    host: ['Stand still. That brown you\'re wearing. Is that on purpose?', 'I\'ve mixed every colour in the desert. I go and look at the place first. The colour is always already there.', 'So I\'ve been about.'],
    hostPoint: 'I got my best red to the {way}, {far}. There\'s something there you should see. I\'ve marked it.',
    hostNone: 'You\'ve seen every colour I have. Bring me a new one.',
    hostAfter: ['Undyed is a colour too. It\'s the hardest to get right.', 'Sun fades everything except indigo. Indigo fades you.', 'Come back when the purple is ready. You\'ll smell it.'],
  },
  'wind-towers': {
    any: [
      'Stand under the tower. Feel that? That\'s the whole trick.',
      'The water walks here from the mountain, underground. It takes a week.',
      'There\'s ice in the cone. In summer. Go and look.',
      'Every one of those mounds is a well into the same stream.',
      'No river, no spring, and we\'ve never been thirsty.',
      'My grandfather dug the last mile. He never saw the first.',
    ],
    night: ['The towers hum when the wind is right. It keeps the children asleep.', 'We make the ice on nights like this. Clear and still.'],
    child: ['I\'ve been down a shaft. On a rope. Don\'t tell.', 'Ice is my favourite food.'],
    askHost: 'A water warden, in dark teal, walks the line every day. They know what\'s out there.',
    host: ['Don\'t step on the mounds. They\'re older than the town.', 'I walk the line. Out along the shafts in the morning, back by dark. If one falls in, the town is dry in a week.', 'You see a lot from the far end.'],
    hostPoint: 'Out past the last shaft, to the {way}, {far}, there\'s something. I\'ve never had time to go. I\'ve marked it for you.',
    hostNone: 'You\'ve walked further than my line goes. Nothing left to tell you.',
    hostAfter: ['Listen at the next shaft. If you hear water, all is well.', 'The stream is the width of my shoulders. A whole town on that.', 'Dig straight and trust the slope. That\'s all of it.'],
  },
  'stepped-city': {
    any: [
      'The higher you live, the further you carry your water.',
      'Five tiers. I was born on the second and I\'ll die on the second.',
      'You can see the dome from a day away. Then it\'s another day.',
      'The steps are the street. Mind the goats.',
      'They gild the dome again every spring. Somebody\'s job.',
      'Everything rolls downhill here. Rumours go the other way.',
    ],
    night: ['From up here the camps look like a second sky.', 'The gate\'s shut. You\'re one of us till morning.'],
    child: ['I\'ve been to the top. I\'m not supposed to say.', 'If you drop a melon on the fifth tier it gets to the gate before you.'],
    askHost: 'The scribe at the gate, in white, writes down everyone who comes in. Go and be written down.',
    host: ['Name? No. Where from? No. Then where have you been?', 'I write down everywhere anyone has come from. It\'s the only map this city has ever needed.', 'There\'s a gap in it.'],
    hostPoint: 'Here. To the {way}, {far}. Nobody has ever come in from there. Go and tell me why. I\'ve marked it.',
    hostNone: 'You\'ve been everywhere in my book. I\'ll have to start a new one.',
    hostAfter: ['Written down. Go on up.', 'People think the dome is the top of the city. The book is.', 'Come back and tell me what was there.'],
  },
};
