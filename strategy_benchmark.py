"""Offline benchmark for move selection; all artifacts stay in this folder.

This models initial boards and falling patterns, then reports how many pieces
remain at the first deadlock. It does not model the site's random reshuffle.
"""

import argparse
import random
from collections import defaultdict

from classic_pikachu_bot import choose_pair, find_pair, plan_stage, simulate_move


def new_board(seed: int, cols: int = 16, rows: int = 9):
    tiles = [kind for kind in range(1, cols * rows // 4 + 1) for _ in range(4)]
    random.Random(seed).shuffle(tiles)
    edge = (0,) * (cols + 2)
    return (edge, *(tuple([0] + tiles[row * cols:(row + 1) * cols] + [0])
                    for row in range(rows)), edge)


def first_deadlock(seed: int, level: int, strategy) -> int:
    board = new_board(seed)
    while True:
        remaining = sum(value != 0 for row in board for value in row)
        if not remaining:
            return 0
        pair = strategy(board, level)
        if pair is None:
            return remaining
        board = simulate_move(board, level, pair)


def first_deadlock_with_plan(seed: int, level: int) -> int:
    board = new_board(seed)
    while True:
        remaining = sum(value != 0 for row in board for value in row)
        if not remaining:
            return 0
        plan = plan_stage(board, level)
        if not plan:
            return remaining
        for pair in plan:
            board = simulate_move(board, level, pair)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--seeds", type=int, default=5)
    parser.add_argument("--planned", action="store_true", help="Also evaluate the slower beam planner")
    args = parser.parse_args()
    results = defaultdict(list)
    for level in range(1, 10):
        for seed in range(args.seeds):
            board_seed = level * 1000 + seed
            results[(level, "first")].append(first_deadlock(
                board_seed, level, lambda board, _: find_pair(board)))
            results[(level, "scored")].append(first_deadlock(
                board_seed, level, choose_pair))
            if args.planned:
                results[(level, "planned")].append(first_deadlock_with_plan(board_seed, level))
    for level in range(1, 10):
        print(f"stage {level}: first={results[(level, 'first')]} "
              f"scored={results[(level, 'scored')]} "
              f"planned={results[(level, 'planned')] if args.planned else 'not run'}")


if __name__ == "__main__":
    main()
