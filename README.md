# Classic Pikachu browser solver

`classic_pikachu_bot.py` plays the Classic Pikachu game at
[pikachucodien.net](https://www.pikachucodien.net/). It reads the rendered board,
finds equal tiles that can be connected with at most two turns, and clicks them
through Chrome. It reads the board again after every pair because levels 2–9
move the remaining tiles. When no move exists, it uses the game's shuffle button.

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
```
