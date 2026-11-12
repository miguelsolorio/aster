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
