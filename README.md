# Classic Pikachu browser solver

`classic_pikachu_bot.py` plays the Classic Pikachu game at
[pikachucodien.net](https://www.pikachucodien.net/). It reads the rendered board,
finds equal tiles that can be connected with at most two turns, and clicks them
through Chrome. It plans several matches ahead with a bounded beam search,
simulating the board after every possible pair. Plans favor boards that keep
more tile types playable and avoid dead ends. The solver reads the real board
after every move and only uses the game's shuffle button when no pair remains.

The simulation follows each stage's movement rule:

| Stage | Tile movement after a pair |
| --- | --- |
| 1 | Stays in place |
| 2–5 | Down, up, left, right |
| 6 | Upper region up; lower region down |
| 7 | Upper region down; lower region up |
| 8 | Left region left; right region right |
| 9 | Left region right; right region left |

The solver checks the observed board against its predicted movement after each
pair. Planning reduces avoidable deadlocks, though some generated boards may
still require a shuffle. It reports the number of shuffles used after a win.

## Setup

Run Python in the Conda `base` environment, with Selenium installed:

```powershell
conda run -n base python -m pip install selenium
```

Chrome and a matching ChromeDriver must be available. Selenium Manager can
locate or download the driver automatically; `--driver` also accepts a local
ChromeDriver executable.

## Play

```powershell
conda run -n base python classic_pikachu_bot.py
```

For a background run or a short check:

```powershell
conda run -n base python classic_pikachu_bot.py --headless
conda run -n base python classic_pikachu_bot.py --headless --max-moves 2
```

After a win or a game-over result, the visible browser stays open so you can
inspect the result. Close the Chrome window when you are done. Headless runs
exit automatically; `--close-on-result` does the same for a visible browser.
The solver does not use hints or directly change the game's state.

## Tests

```powershell
conda run -n base python -m unittest -v test_classic_pikachu_bot.py
conda run -n base python strategy_benchmark.py --seeds 3 --planned
```

The benchmark reports tiles left at the first deadlock; lower is better, and
zero means the stage cleared without a shuffle. On its seed-zero stage 2 board,
the first-pair strategy stopped with 72 tiles and the planner with 42. On stage
8, those counts were 104 and zero. These are repeatable examples, not a
guarantee for every randomly generated game.
