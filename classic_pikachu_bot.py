"""Solve the Classic Pikachu game at pikachucodien.net with a real browser.

The bot reads rendered tiles, searches for pairs connectable with at most two
turns, and sends pointer events to the game's board. It rereads the board after
every match because later levels move the remaining tiles.
"""

from __future__ import annotations

import argparse
import heapq
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Sequence

from selenium import webdriver
from selenium.common.exceptions import TimeoutException, WebDriverException
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.chrome.service import Service
from selenium.webdriver.support.ui import WebDriverWait


# ---------------------------------------------------------------------------
# Game URL and browser-side board reader
# ---------------------------------------------------------------------------

GAME_URL = "https://www.pikachucodien.net/games/pikachu-2026/index.html"
READ_GAME = r"""
const board = document.querySelector('#board');
if (!board) return null;
const pieces = [...board.querySelectorAll('.piece')];
if (!pieces.length) return null;
const cells = pieces.filter(p => !p.classList.contains('hidden')).map(p => ({
    col: Math.round(parseFloat(p.style.left) / 42),
    row: Math.round(parseFloat(p.style.top) / 52),
    kind: 1 - Math.round(parseFloat(p.style.backgroundPositionX) / 40)
}));
return {
    cols: Math.max(...pieces.map(p => Math.round(parseFloat(p.style.left) / 42))),
    rows: Math.max(...pieces.map(p => Math.round(parseFloat(p.style.top) / 52))),
    cells,
    level: Number(document.querySelector('#level').textContent),
    shuffles: Number(document.querySelector('#blood').textContent),
    score: Number(document.querySelector('#score').textContent),
    modal: document.querySelector('#modal').hidden ? '' : document.querySelector('#mTitle').textContent,
    actions: [...document.querySelectorAll('#mActs button')].map(b => b.textContent)
};
"""

PLAY_PAIR = r"""
const [a, b, done] = arguments;
const board = document.querySelector('#board');
const rect = board.getBoundingClientRect();
const scale = rect.width / board.offsetWidth;
for (const tile of [a, b]) {
    const clientX = rect.left + (tile.col + .5) * 42 * scale;
    const clientY = rect.top + (tile.row + .5) * 52 * scale;
    board.dispatchEvent(new PointerEvent('pointerdown', {
        bubbles: true, cancelable: true, clientX, clientY, pointerType: 'mouse'
    }));
}
// The game applies removal, gravity and level transitions after 200 ms.
setTimeout(() => done(true), 235);
"""


# ---------------------------------------------------------------------------
# Board model and two-turn path search
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class Tile:
    row: int
    col: int


@dataclass(frozen=True)
class GameState:
    board: tuple[tuple[int, ...], ...]
    level: int
    shuffles: int
    score: int
    modal: str
    actions: tuple[str, ...]

    @property
    def remaining(self) -> int:
        return sum(value != 0 for row in self.board for value in row)


def parse_state(raw: dict) -> GameState:
    """Add the empty border that paths may use to go around the board."""
    rows, cols = raw["rows"], raw["cols"]
    board = [[0] * (cols + 2) for _ in range(rows + 2)]
    for cell in raw["cells"]:
        row, col, kind = cell["row"], cell["col"], cell["kind"]
        if not (1 <= row <= rows and 1 <= col <= cols and kind > 0):
            raise ValueError(f"Unexpected tile in page: {cell!r}")
        board[row][col] = kind
    return GameState(
        board=tuple(tuple(row) for row in board),
        level=raw["level"],
        shuffles=raw["shuffles"],
        score=raw["score"],
        modal=raw["modal"],
        actions=tuple(raw["actions"]),
    )


def find_pair(board: Sequence[Sequence[int]]) -> tuple[Tile, Tile] | None:
    """Find equal tiles joined by an unobstructed path with <= 2 turns.

    Dijkstra search tracks position, direction and turn count. The zero border
    permits the same outside routes that the game accepts.
    """
    rows, cols = len(board), len(board[0])
    directions = ((-1, 0), (0, 1), (1, 0), (0, -1))

    for start_row in range(1, rows - 1):
        for start_col in range(1, cols - 1):
            kind = board[start_row][start_col]
            if kind == 0:
                continue
            start = Tile(start_row, start_col)
            queue = [(0, 0, start_row, start_col, -1)]
            best: dict[tuple[int, int, int], int] = {}

            while queue:
                turns, steps, row, col, previous = heapq.heappop(queue)
                if turns > 2:
                    break
                if previous >= 0 and best.get((row, col, previous), 3) < turns:
                    continue

                for direction, (dr, dc) in enumerate(directions):
                    new_turns = turns + (previous >= 0 and direction != previous)
                    if new_turns > 2:
                        continue
                    next_row, next_col = row + dr, col + dc
                    if not (0 <= next_row < rows and 0 <= next_col < cols):
                        continue
                    value = board[next_row][next_col]
                    if value:
                        if value == kind and (next_row, next_col) != (start_row, start_col):
                            return start, Tile(next_row, next_col)
                        continue
                    key = (next_row, next_col, direction)
                    if new_turns < best.get(key, 3):
                        best[key] = new_turns
                        heapq.heappush(queue, (new_turns, steps + 1, next_row, next_col, direction))

    return None


# ---------------------------------------------------------------------------
# Browser control and game loop
# ---------------------------------------------------------------------------

class GameOverError(RuntimeError):
    """A finished game that did not reach the victory screen."""


def open_browser(headless: bool, driver_path: Path | None) -> webdriver.Chrome:
    options = Options()
    options.add_argument("--window-size=1440,1000")
    options.add_argument("--disable-notifications")
    if headless:
        options.add_argument("--headless=new")
    service = Service(executable_path=str(driver_path)) if driver_path else Service()
    return webdriver.Chrome(service=service, options=options)


def read_state(driver: webdriver.Chrome) -> GameState:
    raw = driver.execute_script(READ_GAME)
    if raw is None:
        raise RuntimeError("The Classic Pikachu board did not load.")
    return parse_state(raw)


def click_action(driver: webdriver.Chrome, label: str) -> None:
    clicked = driver.execute_script(
        "const label=arguments[0]; const button=[...document.querySelectorAll('#mActs button')]"
        ".find(b => b.textContent.trim() === label); if (!button) return false; button.click(); return true;",
        label,
    )
    if not clicked:
        raise RuntimeError(f"Could not find modal action {label!r}.")


def wait_for_review(driver: webdriver.Chrome, enabled: bool) -> None:
    """Keep a visible result on screen until the user closes Chrome."""
    if not enabled:
        return
    print("Result is visible in Chrome. Close the browser window when done reviewing.")
    while True:
        try:
            if not driver.window_handles:
                return
        except WebDriverException:
            return  # Closing the window may also end the WebDriver session.
        time.sleep(1)


def play(driver: webdriver.Chrome, max_moves: int | None, pause_on_result: bool) -> GameState:
    driver.get(GAME_URL)
    WebDriverWait(driver, 30).until(lambda d: d.execute_script(READ_GAME) is not None)
    moves = 0

    while True:
        state = read_state(driver)

        if state.modal:
            if "Hoàn thành" in state.modal:
                print(f"Victory: all 9 levels complete. Final score: {state.score}.")
                wait_for_review(driver, pause_on_result)
                return state
            if "Bàn tiếp theo" in state.actions:
                print(f"Level {state.level - 1} clear; score {state.score}.")
                click_action(driver, "Bàn tiếp theo")
                WebDriverWait(driver, 10).until(lambda d: not read_state(d).modal)
                continue
            print(f"Game stopped: {state.modal} (score {state.score}).")
            wait_for_review(driver, pause_on_result)
            raise GameOverError(f"Game stopped: {state.modal} (score {state.score}).")

        if max_moves is not None and moves >= max_moves:
            print(f"Stopped after {moves} moves for inspection. Level {state.level}, score {state.score}.")
            return state

        pair = find_pair(state.board)
        if pair is None:
            if state.shuffles <= 0:
                print(f"No available pair or remaining shuffles. Level {state.level}, score {state.score}.")
                wait_for_review(driver, pause_on_result)
                raise GameOverError("No available pair or remaining shuffles.")
            print(f"Level {state.level}: no pair available; shuffling ({state.shuffles} left).")
            driver.execute_script("document.querySelector('#btnShuffle').click()")
            continue

        first, second = pair
        driver.execute_async_script(
            PLAY_PAIR,
            {"row": first.row, "col": first.col},
            {"row": second.row, "col": second.col},
        )
        updated = read_state(driver)
        if not updated.modal and updated.level == state.level and updated.remaining >= state.remaining:
            raise RuntimeError(
                f"Pair {first} and {second} was not removed; board may have changed."
            )
        moves += 1
        if moves % 20 == 0:
            print(f"Move {moves}: level {updated.level}, {updated.remaining} tiles left, score {updated.score}.")


# ---------------------------------------------------------------------------
# Command-line entry point
# ---------------------------------------------------------------------------

def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--headless", action="store_true", help="Run Chrome without a visible window")
    parser.add_argument("--close-on-result", action="store_true", help="Exit without waiting for you to close Chrome")
    parser.add_argument("--driver", type=Path, help="Path to a ChromeDriver executable")
    parser.add_argument("--max-moves", type=int, help="Stop after N matches for a short test")
    args = parser.parse_args()
    if args.max_moves is not None and args.max_moves < 0:
        parser.error("--max-moves must be nonnegative")

    driver = None
    try:
        driver = open_browser(args.headless, args.driver)
        play(driver, args.max_moves, pause_on_result=not (args.headless or args.close_on_result))
        return 0
    except GameOverError:
        return 1  # The result was printed before the review pause.
    except (TimeoutException, WebDriverException, RuntimeError, ValueError) as error:
        print(f"Error: {error}")
        return 1
    finally:
        if driver is not None:
            try:
                driver.quit()
            except WebDriverException:
                pass  # The user may already have closed the browser.


if __name__ == "__main__":
    raise SystemExit(main())
