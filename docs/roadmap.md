# Roadmap

Ten ideas to take Aster further, in the order they should be built. Only the first has a full spec. The rest get specified when their turn comes, so the detail is never stale.

## Principles

These hold for every idea below.

- **Calm.** No failure, no meters, no death. Weather, giants and anything else new are things to see and use, never threats.
- **Static.** The game stays a static site. Anything that needs a server waits.
- **Nothing downloaded.** Creatures, sounds, glyphs and everything else are generated from the seed, like the rest of the world.
- **Nobody tells you where to go.** New things announce themselves through the world, not through icons, markers or forecasts.

## The order

1. **Weather.** Wind, sandstorms and rare rain. Specified below.
2. **Flute songs.** Short melodies learned from people, from wind in an arch, from a shell. Each does something: calls an animal, wakes standing stones, opens a sealed cavern, raises a breeze under the carpet. Comes after weather so there is wind and rain for songs to act on.
   As built: five songs. The call comes with the flute. The other four are learned by playing the flute at a kind of place, which answers with its melody: standing stones (the waking song), an arch (the wind song), a buried shell (the rain song), a cave (the opening song). A tap on R plays the song that suits where you stand; holding R opens a ring to choose. The waking song lights the stones and marks the nearest place you have not found, as the spyglass would. The wind song gives a tailwind in the air for fourteen seconds. The rain song brings a rain within a few minutes, once every three in-game days. The opening song opens a sealed cavern without the pick.
3. **Bring a place back.** Carry water to an empty hamlet's well, relight a watchtower, plant a grove at a spring. People move in and caravans reroute, so the map changes because of you. The largest of the first three: it touches settlements, people and routes.
   As built: three kinds of place, each wanting one thing carried from another kind of place. A hamlet's dry well wants water (any river or pool), a lone watchtower's cold beacon wants a flame (a lantern tower), the ground below a mountain spring wants date stones (a grove or an oasis). The wanderer carries one of each at most. A place comes back in stages on the world clock, and only the day it was restored is saved. Hamlet: water in the well at once, people and lit windows after a day, a caravan camp and more planting after two. Watchtower: the beacon at once, seen at night from up to 14 km, and a keeper after a day. Spring: seedlings, young palms after a day, a grove after three. Untouched hamlets and lone towers are now dark at night, where before they were lit with nobody home. Caravans do not change their routes: a party camps beside a restored hamlet. The map marks a restored place with a dot.
4. **A sky worth reading.** Constellations that turn through the night, a moon with phases, meteor showers, a comet, an eclipse. The observatory keeper teaches star shapes, and some finds can only be located by the sky.
   As built: the stars turn about a pole star (the Nail) 38 degrees up in the north, once a day and a little further each night. Eight constellations and the Nail are drawn as brighter points over the small stars; the star-house keeper teaches the Nail and then one constellation a night, after dark, and a taught one has its lines drawn and is named through the spyglass. The moon's month is 8 nights, so the phase changes visibly night to night; every third full moon is copper. A shower falls every fifth night (the second night of a new save is the first), and after half a minute of open night sky one star comes down 1.3 to 2.4 km off. The crater it leaves is the thirty-first find and the only one located by the sky. A comet stays three nights in thirteen. The sun is eclipsed one day in eleven at mid-morning (the fourth day is the first): the light goes to a deep dusk for about two real minutes and the stars come out. Everything is worked out from the world clock, so only the lessons and the fallen stars are saved. Not done: the moon still rides opposite the sun whatever its phase, and night light does not change with the phase.
5. **A calendar.** A lunar month built on the moon from the sky work and the world clock from the weather work: market days, a lantern festival, animal migrations, a night when the salt pan floods and mirrors the sky.
   As built: the month is the sky's eight nights, counted from the new moon. Night 0: the salt pans flood (the rain's mirror, everywhere at once, with stars in it). Days 2 and 6: market day, when a city holds half as many people again. Night 4: the lantern festival, with lanterns rising from the nearest cities, settlements, villages and restored hamlets. Days 5 and 6: the grazing herds travel, out one month and back the next. Townsfolk mention what is coming, and the map carries an almanac of the eight moons with today ringed. Nothing is saved. Not done: a market looks no different beyond the crowd (no extra stalls or goods), herds drift from where they stood and are forgotten once out of range, and nobody but townsfolk talks about the calendar.
6. **A sketchbook.** The wanderer draws each find, animal and person into a journal in the game's own line style. It replaces "Discoveries 3 / 30" with pages to flip through and share.
7. **A lost language.** Glyphs on temples, ruins and cavern walls, learned one word per site and collected in the sketchbook. Together they tell who built all this and where they went, and they point to one far destination. Nothing ever marks it for you, and the world stays endless past it.
8. **Giants on the horizon.** A few colossal, slow creatures crossing the desert on long routes. You can climb one, ride it for a day, and find a small camp living on its back.
9. **The edge of the desert.** Far enough out the sand ends at a sea coast with fishing towns, tide flats and a sail boat. A sand-sailing ship adds a top rung to the speed ladder.
10. **Traces of other wanderers.** Everyone shares one seed, so cairns, footprints and left melodies from other players appear in your world. Parked until there is a backend. Share codes in a URL could give a taste of it without one.

## Spec: weather

Weather ships as two builds. Wind and sandstorms come first because they reuse what exists: the dust particles, the wind uniform, the synthesized wind bed and the pattern caravans already follow at night. Rain is the second build.

### Build one: wind and sandstorms

**States.** Clear most of the time. Wind is common: sand blowing low over the dunes with no loss of view. A sandstorm comes about once every two or three in-game days. A new save has no storm for its first half day and is guaranteed one before the end of its second day.

As built: the seeded schedule is thin on purpose, with about one storm alive within a dozen kilometres at a time, so a wall on the horizon stays an event. That alone would put a walker inside one only every eight days or so. To keep the agreed pace, a storm is sent toward a wanderer who has gone two and a half days without one. A sent storm is saved, so a reload keeps it.

**The world clock.** The save gains a count of in-game days elapsed. It runs only while the game is open. Every storm's time, origin and heading are worked out from the seed and that clock, so nothing about the weather itself is stored, and a reload in the middle of a storm puts you back in the same storm. Sleeping advances the clock by the hours it skips, so a storm overhead when you lie down has moved on when you wake.

**The front.** A storm has a place in the world. It is about 4 km wide and 1.5 km deep, travels at about 12 m/s on a heading, and stands taller than anything can fly. You can go through it or round it, never over it. It overtakes a walker (10.5 m/s on sand), a board outruns it (30 m/s), and it takes about two minutes to pass over someone standing still.

**Warning.** About one in-game hour ahead, through the world only: the wind rises and turns, the horizon on one side goes dark ochre, caravans halt. No icon, no forecast, nothing on the map or the compass.

**Inside.** Three things happen and no more. The view closes to a few dozen metres. The sun and the compass marks disappear. Anything airborne is pushed along the storm's heading: a tailwind carries a glider or carpet up to a quarter past the speed cap, and a headwind slows it by as much. On the ground you move as normal. Outside storms, wind stays cosmetic.

**Shelter.** Caverns, caves and the deeps are fully sheltered. Inside a city or town it is calm, with the storm audible outside. A storm parts round the foot of every mountain and leaves it standing clear, so the mountain villages never see one.

**The world reacts.** People go indoors. Caravans halt and kneel.

**Aftermath.** A storm uncovers at most one wreck along its track: the ribs and keel of a sand-ship, half out of a dune. It is the thirtieth kind of find, it only ever appears in a storm's wake, and it stays once reached.

**Looks.** Weather acts only on the shared light, fog and sky values, so every render look gets it. Tuning is done in the default look. The others are checked on the gallery page and fixed case by case.

**Testing.** `?storm` starts with a front approaching. `?storm=in` starts inside one.

**Things the code already has, and things it lacks.**

- The day cycle is the one writer of fog density, fog colour and sun colour each frame (`src/game/daycycle.ts`). Weather layers on after it. Render looks also write some of those colours when a look is set, so the order matters.
- A wandering wind and a gust value are already computed each frame and carried in the frame state. Cloth, caravan ropes, dust and the wind sound all read them. A storm's heading should drive the same values.
- `src/world/dust.ts` already drifts particles with the wind and throws spindrift off crests in gusts. Its pool is 1,500, and dust density follows the quality tier.
- Nothing pushes the player today. The wind force goes into the flying and board branches of `src/game/player.ts`, and the 60 m/s cap needs lifting for a tailwind.
- Caravans sit and pen their animals on a night threshold. Shelter in a storm follows the same pattern with a storm value in the frame state.
- The save has no clock. New fields default when absent, so adding the day count needs no version bump.

### Build two: rain

Agreed in outline only.

Rain is rare, about once in eight to ten days. The rivers already run all the time and their level is part of the terrain function, so rain does not fill them. It leaves four things, which fade over about a day:

- dark wet sand,
- a thin mirror of standing water on salt pans,
- flowers across the dunes it fell on,
- a rainbow as it clears.

All of it is done in the shader. The terrain shape is untouched, so the CPU and shader versions of the ground cannot fall out of step. Animals come out to drink afterwards. Rain needs its own particle pool and new synthesized voices for rain and thunder.

As built:

- Rain is a travelling cell like a storm, 5 km wide and 3 km deep, crossing at about 7 m/s under one dark cloud. It falls on mountains too.
- The ground it has crossed stays wet for a day after it ends. The ground shader is told about the three nearest stretches. Flowers follow the rain's front by a few in-game hours and go as the ground dries.
- The rainbow stands opposite the sun while rain is falling nearby or has just stopped, when the sun is up but low, and never while you are under the rain yourself.
- The seeded schedule rains on a given spot only about once in fifty days. A rain is sent to a wanderer who has gone nine days without one, and never before day three of a new save.
- Animals: about half again as many herds on wet ground once the rain has eased, grazing more of the time. Birds do not fly in hard rain. Nothing walks to the salt pans to drink.
- Rain drops share the dust particle pool, which was raised to 2,200.
- A Weather setting (menu, Game tab, on by default) turns off storms and rain together. It is kept with the other settings, so "Start over" does not reset it.

### Left for later

Haze on salt pans, snow falling on the mountain and fog in the gorges.
