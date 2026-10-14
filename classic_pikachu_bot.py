"""Solve the Classic Pikachu game at pikachucodien.net with a real browser.

The bot reads rendered tiles, simulates each stage's falling pattern, and
chooses pairs that preserve future moves. It rereads the board after every
match so a shuffle or game update cannot desynchronize the solver.
"""

from __future__ import annotations

import argparse
import time
from dataclasses import dataclass
from itertools import combinations
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


class PathIndex:
    """O(1) straight-line clearance checks for all candidate tile pairs."""

    def __init__(self, board: Sequence[Sequence[int]]) -> None:
        self.board = board
        self.rows, self.cols = len(board), len(board[0])
        self.row_sums = [[0] * (self.cols + 1) for _ in range(self.rows)]
        self.col_sums = [[0] * (self.rows + 1) for _ in range(self.cols)]
        for row in range(self.rows):
            for col in range(self.cols):
                occupied = board[row][col] != 0
                self.row_sums[row][col + 1] = self.row_sums[row][col] + occupied
                self.col_sums[col][row + 1] = self.col_sums[col][row] + occupied

    def clear_row(self, row: int, first: int, last: int) -> bool:
        low, high = sorted((first, last))
        return high - low <= 1 or self.row_sums[row][high] == self.row_sums[row][low + 1]

    def clear_col(self, col: int, first: int, last: int) -> bool:
        low, high = sorted((first, last))
        return high - low <= 1 or self.col_sums[col][high] == self.col_sums[col][low + 1]

    def open_corner(self, row: int, col: int, first: Tile, second: Tile) -> bool:
        return self.board[row][col] == 0 or (row, col) in (
            (first.row, first.col), (second.row, second.col)
        )

    def connected(self, first: Tile, second: Tile) -> bool:
        """Check straight, one-turn and two-turn paths, including outer border."""
        if first == second or self.board[first.row][first.col] != self.board[second.row][second.col]:
            return False
        if first.row == second.row and self.clear_row(first.row, first.col, second.col):
            return True
        if first.col == second.col and self.clear_col(first.col, first.row, second.row):
            return True

        # Any two-turn path has a middle segment on some row or column.
        for row in range(self.rows):
            if (self.open_corner(row, first.col, first, second)
                    and self.open_corner(row, second.col, first, second)
                    and self.clear_col(first.col, first.row, row)
                    and self.clear_row(row, first.col, second.col)
                    and self.clear_col(second.col, row, second.row)):
                return True
        for col in range(self.cols):
            if (self.open_corner(first.row, col, first, second)
                    and self.open_corner(second.row, col, first, second)
                    and self.clear_row(first.row, first.col, col)
                    and self.clear_col(col, first.row, second.row)
                    and self.clear_row(second.row, col, second.col)):
                return True
        return False


def find_pairs(board: Sequence[Sequence[int]]) -> list[tuple[Tile, Tile]]:
    """List all currently playable pairs in a stable order."""
    positions: dict[int, list[Tile]] = {}
    for row in range(1, len(board) - 1):
        for col in range(1, len(board[0]) - 1):
            kind = board[row][col]
            if kind:
                positions.setdefault(kind, []).append(Tile(row, col))
    paths = PathIndex(board)
    return [pair for tiles in positions.values() for pair in combinations(tiles, 2)
            if paths.connected(*pair)]


def find_pair(board: Sequence[Sequence[int]]) -> tuple[Tile, Tile] | None:
    """Compatibility helper for callers needing any legal pair."""
    pairs = find_pairs(board)
    return pairs[0] if pairs else None


# ---------------------------------------------------------------------------
# Exact stage movement and pattern-aware pair selection
# ---------------------------------------------------------------------------

def shift_zone(board: list[list[int]], col_start: int, row_start: int,
               col_end: int, row_end: int, direction: tuple[int, int]) -> None:
    """Repeat the site's ordered one-cell swaps until the zone stops moving."""
    dr, dc = direction
    rows, cols = len(board) - 2, len(board[0]) - 2
    while True:
        moved = False
        for col in range(col_start, col_end + 1):
            for row in range(row_start, row_end + 1):
                target_row, target_col = row + dr, col + dc
                if (board[row][col] and 1 <= target_row <= rows
                        and 1 <= target_col <= cols and board[target_row][target_col] == 0):
                    board[target_row][target_col] = board[row][col]
                    board[row][col] = 0
                    moved = True
        if not moved:
            return


def simulate_move(board: Sequence[Sequence[int]], level: int,
                  pair: tuple[Tile, Tile]) -> tuple[tuple[int, ...], ...]:
    """Remove a pair and apply the game's level-specific falling pattern."""
    result = [list(row) for row in board]
    first, second = pair
    result[first.row][first.col] = result[second.row][second.col] = 0
    rows, cols = len(result) - 2, len(result[0]) - 2
    half_row, half_col = (rows + 1) // 2, cols // 2
    full = (1, 1, cols, rows)

    if level == 2:        # down
        shift_zone(result, *full, (1, 0))
    elif level == 3:      # up
        shift_zone(result, *full, (-1, 0))
    elif level == 4:      # left
        shift_zone(result, *full, (0, -1))
    elif level == 5:      # right
        shift_zone(result, *full, (0, 1))
    elif level == 6:      # top up, bottom down
        shift_zone(result, 1, half_row, cols, rows, (1, 0))
        shift_zone(result, 1, 1, cols, half_row - 1, (-1, 0))
    elif level == 7:      # bottom up, top down; boundary crossing is possible
        shift_zone(result, 1, half_row, cols, rows, (-1, 0))
        shift_zone(result, 1, 1, cols, half_row - 1, (1, 0))
    elif level == 8:      # left half left, right half right
        shift_zone(result, 1, 1, half_col, rows, (0, -1))
        shift_zone(result, half_col + 1, 1, cols, rows, (0, 1))
    elif level == 9:      # left half right, right half left
        shift_zone(result, 1, 1, half_col, rows, (0, 1))
        shift_zone(result, half_col + 1, 1, cols, rows, (0, -1))
    elif level != 1:
        raise ValueError(f"Unknown level: {level}")
    return tuple(tuple(row) for row in result)


def choose_pair(board: Sequence[Sequence[int]], level: int) -> tuple[Tile, Tile] | None:
    """Prefer moves that leave many distinct pair choices after the shift."""
    pairs = find_pairs(board)
    if not pairs:
        return None
    if len(pairs) == 1:
        return pairs[0]

    best_pair, best_score = pairs[0], (-1, -1, -1)
    for pair in pairs:
        next_board = simulate_move(board, level, pair)
        next_pairs = find_pairs(next_board)
        remaining = sum(value != 0 for row in next_board for value in row)
        distinct_kinds = len({next_board[a.row][a.col] for a, _ in next_pairs})
        score = (remaining == 0 or bool(next_pairs), distinct_kinds, len(next_pairs))
        if score > best_score:
            best_pair, best_score = pair, score
    return best_pair


BEAM_WIDTH = 12
PLAN_NODE_BUDGET = 3000
PLAN_TIME_BUDGET = 4.0


def plan_stage(board: tuple[tuple[int, ...], ...], level: int,
               beam_width: int = BEAM_WIDTH,
               node_budget: int = PLAN_NODE_BUDGET,
               time_budget: float = PLAN_TIME_BUDGET) -> list[tuple[Tile, Tile]]:
    """Plan as many matches as possible before any shuffle is needed.

    Each beam layer represents one more removed pair. Boards that still have
    moves are kept; boards that deadlock are discarded while a continuation
    exists. If a complete solution is found, its whole path is returned.
    Node and wall-time budgets bound planning on unusually branchy boards.
    """
    initial_pairs = find_pairs(board)
    if not initial_pairs:
        return []
    if beam_width < 1 or node_budget < 1 or time_budget <= 0:
        raise ValueError("Planning budgets must be positive.")

    remaining = sum(value != 0 for row in board for value in row)
    frontier = [(board, (), initial_pairs)]
    best_path: tuple[tuple[Tile, Tile], ...] = ()
    explored = 0
    deadline = time.perf_counter() + time_budget

    def before_deadlock(path: tuple[tuple[Tile, Tile], ...]) -> list[tuple[Tile, Tile]]:
        # Replan shortly before a dead end found by the beam. A path cut short
        # by the budget already ends on a board known to have another move.
        return list(path[:max(1, len(path) - 3)])

    while frontier:
        successors = {}
        terminal_path = None
        for current, path, pairs in frontier:
            for pair in pairs:
                if explored >= node_budget or time.perf_counter() >= deadline:
                    if successors:
                        return list(max(successors.values(), key=lambda value: value[0])[1])
                    return list(best_path or (pair,))
                explored += 1
                next_board = simulate_move(current, level, pair)
                next_path = path + (pair,)
                if remaining == 2:
                    return list(next_path)

                next_pairs = find_pairs(next_board)
                if not next_pairs:
                    terminal_path = next_path
                    continue

                accessible = {next_board[a.row][a.col] for a, _ in next_pairs}
                counts = {}
                for row in next_board:
                    for kind in row:
                        if kind:
                            counts[kind] = counts.get(kind, 0) + 1
                stranded_twins = sum(count == 2 and kind not in accessible
                                      for kind, count in counts.items())
                score = (len(accessible), -stranded_twins, len(next_pairs))
                previous = successors.get(next_board)
                if previous is None or score > previous[0]:
                    successors[next_board] = (score, next_path, next_pairs)

        if not successors:
            return before_deadlock(terminal_path) if terminal_path else list(best_path)
        ranked = sorted(successors.items(), key=lambda item: item[1][0], reverse=True)
        frontier = [(candidate, path, pairs)
                    for candidate, (_, path, pairs) in ranked[:beam_width]]
        best_path = frontier[0][1]
        remaining -= 2

    return list(best_path)


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
    shuffles_used = 0
    plan: list[tuple[Tile, Tile]] = []
    planned_board = None
    planned_level = None

    while True:
        state = read_state(driver)

        if state.modal:
            if "Hoàn thành" in state.modal:
                print(f"Victory: all 9 levels complete. Final score: {state.score}. "
                      f"Shuffles used: {shuffles_used}.")
                wait_for_review(driver, pause_on_result)
                return state
            if "Bàn tiếp theo" in state.actions:
                print(f"Level {state.level - 1} clear; score {state.score}.")
                click_action(driver, "Bàn tiếp theo")
                plan = []
                WebDriverWait(driver, 10).until(lambda d: not read_state(d).modal)
                continue
            print(f"Game stopped: {state.modal} (score {state.score}).")
            wait_for_review(driver, pause_on_result)
            raise GameOverError(f"Game stopped: {state.modal} (score {state.score}).")

        if max_moves is not None and moves >= max_moves:
            print(f"Stopped after {moves} moves for inspection. Level {state.level}, score {state.score}.")
            return state

        if state.board != planned_board or state.level != planned_level:
            plan = []
        if not plan:
            started = time.perf_counter()
            plan = plan_stage(state.board, state.level)
            planned_board, planned_level = state.board, state.level
            if plan:
                print(f"Level {state.level}: planned {len(plan)} matches "
                      f"in {time.perf_counter() - started:.1f}s.")
        pair = plan.pop(0) if plan else None
        if pair is None:
            if state.shuffles <= 0:
                print(f"No available pair or remaining shuffles. Level {state.level}, score {state.score}.")
                wait_for_review(driver, pause_on_result)
                raise GameOverError("No available pair or remaining shuffles.")
            print(f"Level {state.level}: no pair available; shuffling ({state.shuffles} left).")
            driver.execute_script("document.querySelector('#btnShuffle').click()")
            shuffles_used += 1
            plan = []
            continue

        first, second = pair
        expected = simulate_move(state.board, state.level, pair)
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
        if not updated.modal and updated.level == state.level:
            if updated.shuffles < state.shuffles:
                shuffles_used += state.shuffles - updated.shuffles  # Site auto-shuffle.
                print(f"Level {state.level}: automatic shuffle with {updated.remaining} tiles left "
                      f"({updated.shuffles} chances remain).")
                plan = []
            elif updated.board != expected:
                raise RuntimeError("Observed tile movement differs from the stage model.")
            else:
                planned_board = expected
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
