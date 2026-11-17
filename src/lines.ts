// The broadcast booth. Deadpan at all times.

const L = {
  intro7: [
    "Welcome to the seventh. A hundred and seventy-five yards, all of it somebody else's problem.",
    "Widow's Pond on the right. It has a name because it has a history.",
    'A par three. The marshal is in his cart and, we are told, in a mood.',
  ],
  intro8: [
    'Gator Alley. Five hundred yards along the river. The alligators are plastic. Mostly.',
    'The eighth. The river crosses in front of the green, because of course it does.',
    'A long par five. Local knowledge says keep left. Local knowledge has lost a lot of balls.',
  ],
  pure: [
    'Oh, that is flushed. Off the screws.',
    'Pure. You could hear that one from the car park.',
    'Dead centre of the face. Suspiciously good, if anything.',
    "That's the one he'll tell people about.",
  ],
  good: ["That'll play.", 'Solid enough.', 'A golf shot. A recognisable golf shot.', 'Fine. Nobody was hurt.'],
  hook: ["That's going left. And it's still going left.", 'A hook. The ball has seen something it wants over there.', 'Left of left.'],
  slice: ["And there's the slice. Right on schedule.", 'That is leaking right like a cheap tent.', "A big banana. He's aimed at one county and landed in another."],
  shank: [
    "Shank. We don't say that word in the booth. Shank.",
    'Off the hosel. That nearly killed a man in the next fairway.',
    'That went sideways. Genuinely sideways.',
  ],
  chunk: [
    "Fat. He's taken a divot the size of a bath mat.",
    'More earth than ball there. A lot more.',
    "He's laid the sod over that one.",
  ],
  top: ['Topped it. A worm-burner. The worms have filed a complaint.', 'That never got above knee height.', 'Along the floor. A putt, with the wrong club.'],
  whiff: [
    'An air shot. The ball has not moved. It counts.',
    'He has missed it. Entirely. The ball is embarrassed for him.',
    'A practice swing, he will say. It was not a practice swing.',
    'Nothing but atmosphere. That is a stroke.',
  ],
  toe: [
    'Off the toe. It has gone sideways like a startled crab.',
    'Right off the end of the club. There is no grass on that part.',
    'Toed it. The ball barely noticed.',
  ],
  yip: ['A yip. A full-body yip.', 'He flinched. You hate to see it. We love to see it.'],
  steer: [
    'The ball appears to be... turning. In the air. On its own.',
    'Remarkable late movement on that one. Physically remarkable.',
    "I've never seen a ball change its mind before.",
    'That is not what the wind is doing, but all right.',
    "It's bending like it owes somebody money.",
  ],
  nudge: [
    'That ball is rolling uphill. I would like that noted.',
    'It has... sped up. On the green. By itself.',
  ],
  caught: [
    'The marshal saw that. The marshal definitely saw that.',
    'And the marshal is writing something down.',
    "He's put the binoculars up. Nobody move.",
  ],
  water: ['Wet.', "That's in the drink.", "A water ball. He'll want that one back. He can't have it.", "Splash. One more for the pond's collection."],
  gator: [
    'The alligator has taken the ball. Local rule: do not ask for it back.',
    'Eaten. The gator is plastic, we were assured. He seems very animated for plastic.',
    "That's a one-stroke penalty and a new entry on the alligator's menu.",
  ],
  gatorBounce: ["Off the alligator! He's fine. He's plastic. We think.", 'A lucky kick off the reptile.'],
  log: ['Off the log! The river giveth.', "It's hit a floating log and stayed dry. You could try that a thousand times."],
  tree: ['Timber.', 'Trees are ninety percent air. That was the other ten.', "In the branches. It's rattling around in there like a pinball."],
  trunk: ['Solid oak. The oak wins.', 'Straight off the trunk.'],
  cart: ["Off the cart! That's coming out of somebody's deposit.", "He's hit the marshal's cart. Bold. Stupid, but bold."],
  bench: ['Off the bench. Furniture is in play today.'],
  sign: ['Off the tee sign. Par, it says. Optimistic.'],
  bridge: ['Off the bridge rail. Everything is a backboard if you believe.'],
  path: ["Cart path. It's going to bounce forever.", 'On the concrete. Free yardage.'],
  sand: ['Bunker.', 'On the beach.', "Sand. He's brought a bucket and spade, we hope."],
  rough: ['In the cabbage.', "That's found the long stuff.", "Rough. He'll need a search party and a strimmer."],
  fairway: ['Fairway. Short grass. Lovely.', 'Found the fairway. Mark the date.'],
  ob: ['Out of bounds. Gone. Reload.', "That's left the property.", "It's in the trees and it is not coming back."],
  green: ['On the dance floor.', 'Putting surface.', "That's on. Don't ask how."],
  close: ["Oh, that's stiff. That is a kick-in.", 'Tight. Very tight. Suspiciously tight.'],
  lipout: ['Lipped out! Cruel. Deserved, possibly, but cruel.', 'All the way round the rim and out again.'],
  pin: ['Off the flagstick!', "It's clattered the pin."],
  holed: ['In the hole.', 'Drops. Never in doubt, apart from all the doubt.', "That's in. Write it down before anybody checks."],
  dunk: ['SLAM DUNK. Straight in on the fly!', 'No bounce, no roll, just in. Check that ball for a homing device.'],
  ace: ['A HOLE IN ONE. Completely legitimate. Do not review the footage.'],
  honest: ['Playing this one straight, apparently. Brave.', "No funny business on this hole. We'll see how long that lasts."],
  card: ['Something has changed hands down there.', "The caddie has just handed him something. We don't know what. We don't want to know."],
  foot: ['Did he just... kick it? He kicked it.', "The foot wedge. A classic. The marshal's favourite."],
  mulligan: ["He's taking that one again, it seems. No one has objected. No one was asked."],
  pickup: ["He's picking up. The group behind has started throwing things."],
  dq: [
    'And here comes the marshal. He is not coming over to say well played.',
    "That's it. He's been disqualified. The cart ride of shame.",
  ],
  suspicious: ['The marshal is getting twitchy.', "One more of those and it's the long walk to the car park."],
} as const;

export type LineKey = keyof typeof L;
const last = new Map<LineKey, number>();

export function line(key: LineKey): string {
  const arr = L[key];
  let i = Math.floor(Math.random() * arr.length);
  if (arr.length > 1 && last.get(key) === i) i = (i + 1) % arr.length;
  last.set(key, i);
  return arr[i]!;
}
