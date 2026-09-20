# What is Metarouter?
In Cookie Clicker, collectibles called "golden cookies" occasionally spawn on-screen and can be clicked for a bonus. Bonuses include "buffs", which boosts cookie production by some amount for some amount of time. The most common buff is "Frenzy", which grants 7x cookie production for 77 seconds by default, but there are more buffs. Upgrades exist to boost golden cookie spawning frequency and the duration of its buffs.

A "Combo" refers to intentionally stacking buffs to get a higher bonus for a short time. Two different buffs (such as Frenzy and Click frenzy) at the same time will usually stack its multipliers multiplicatively, resulting in dramatically increased production, with especially big combos producing billions of years worth of CpS per combo.

The Grimoire minigame (from Wizard towers) has a spell called Force the Hand of Fate that spawns a golden cookie on use. Unlike naturally spawned golden cookies, the outcome of these golden cookies can be **predicted** using the [FtHoF Planner (v6.1)](https://plasma4.github.io/FtHoF-Planner-v6)

Players with a large amount of Wizard towers (typically above 800) can chain various mechanics in the Grimoire, combined with predictions from the FtHoF Planner, to obtain far more buffs than normal. This is called Grimoire routing, which this app is designed to automate. It:
- takes in a save file or a seed,
- given some restrictions (e.g. max tower count),
- predicts the outcome of a small number of future spells,
- finds a combination of actions in the Grimoire that will grant the highest multipliers possible.

# Usage guide
Here's how to use Metarouter to route a section of your save:
1. Export your save. Options -> Export save -> Ctrl+C (Copy). 
2. Paste the save into the text box in Metarouter and click "Import save".
3. Enter or modify the additional information above the disabled "Click to route combo" button. Once you have filled in enough information, the button will light up.
4. Click "Click to route combo" to start the search.
5. After it has finished, the results will be available below.

## Capabilities
- Finds the set of actions that grant the highest buff multiplier, for up to 20 rows at a time.
- Can consider selling/buying Wizard towers; changing seasons; refilling magic; managing onscreen counts; using, offsetting, transmuting, and refunding Gambler's Fever Dreams.
- Is able to balance the strengths of different buffs to achieve a higher total multiplier, under the assumption that a Building Special gives roughly 80x CpS (for a late game player)
- Output full instructions for execution.

## Limitations
- Is unable to intentionally reduce magic by reducing max magic to be lower than current magic to achieve a higher yield.
- Availability of the Supreme Intellect and Reality Bending auras are assumed and always used during the route.
- Some actions, such as SI/RB swap and Funny frame, is not available.
- Does not ensure human feasibility.

## Common questions
Q: I don't have over 800 Wizard towers, can I still use this?
A: Yes, but the combos found will be less powerful. Faithfully input your tower count and let the router do the work.

Q: The route doesn't work!
A: Check the following: You have Supreme Intellect and Reality Bending auras slotted during the entire execution; you entered the correct tower level at top right of the chart; you did all actions in between two dashed lines in 1 second or less. If that still doesn't work, [open an issue](https://github.com/CursedSliver/autorouter/issues/new).

Q: It's taking a really long time to find a combo.
A: The router is not a magic wand, and will not find the best combo if supplied with a lot of rows. You can keep waiting, or stop it and reduce the lookahead to make it faster.

Q: The instructions are far too complex!
A: Adjust the feasibility settings to enforce a simpler route.

Q: Is the output really the optimal route?
A: It should be within its limitations, but if you think it isn't for any reason, you can open an issue.

# Contact
For feedback, bugs, or suggestions, open up an issue or DM me on Discord: @cursedsliver after joining the [Cookie clicker discord server](https://discord.gg/cookie).

# How does this work?
At its heart, it is an exhaustive search algorithm. It goes through every possible sequence of actions that you can do and finds the one that gives the highest multiplier. It is made faster by the following optimizations:
- Action set: instead of having to test out every possible wizard tower count, select an action set that only represents meaningfully different final actions, with tower counts being bundled with them.
- Basic pruning: branchs that are obviously strictly worse than another is discarded early, before the tree is traversed deeper from that point.
- Microrouter: a second autorouter that routes with the assumption of infinite resources. This is used to find an upper bound for the multiplier at every point in the combo, which allows for significant pruning of branchs.

## Action set
All spells cost some amount of base magic + some percentage of your max magic. Therefore, if you have a lot of max magic, you could decrease the tower count (and thus, maximum magic) after casting a spell to make the next spell cheaper and be able to cast more spells. For example, normally casting two Force the Hand of Fate (FtHoF)'s consecutively is impossible, but if you first cast it with full magic and 321 towers (assuming level 1 towers), then sell to 21 towers, you can cast FtHoF again. 

The metarouter will also find precise tower counts to do this, but it doesn't do that by trying every possible tower count. Instead, it assumes that you will always cast any spell as cheaply as possible. Given this assumption, the cheapest way to cast any spell is to cast it with the least amount of max magic that doesn't cause your existing magic to be overridden by your max magic, i.e. cast with the same amount of max magic as current magic. Then, it will try to find matching tower counts to the maximum magic count, which is equal to the current magic, for each action.

You can find more information in `src/app/route/route.ts`.

## Pruning and microrouter
For basic pruning, a branch is pruned if it satisfies the following properties:
- It has a strictly lower or equal multiplier (score) than another branch at the same row.
- It has a strictly lower or equal magic than another branch at the same row.
- It has no pending GFD resolves. 

The microrouter produces upper bounds on the multiplier that you can get at every point in the combo. It asks the question "if I started at spell X, and I had infinite magic and resources, what is the highest multiplier that I can get?" For every spell count, it iterates through them, and finds the one with the highest multiplier. Because magic is unlimited, it is the highest multiplier that can be obtained in all spells **after** spell X. For some partially explored branch A that ends at spell Y, it is pruned if it satisfies the following property:

`(Current multiplier at spell Y) * (maximum future multiplier after spell Y) <= (Final multiplier of another branch)`

You can find more information in `src/app/route/microrouter.ts`.

# Contribute
Please contribute! We would love a more optimized autorouter that can route more things faster. You can contribute directly by opening up a pull request, however, take note of the following:
- You must provide an overview of the changes made in the pull request and how it optimizes the performance of routing, alongside **reproducible test** showing increased speed while maintaining accuracy. Though, you can also improve it by adding more mechanics.
- I will not accept pull requests that only modify the UI or other nonessential parts of the app unless previously addressed in a noteworthy Issue.
- Use of AI is allowed everywhere **except** within the actual search algorithm, in `src/app/route/`. 