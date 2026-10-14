"""Focused checks for the board parser and two-turn path search."""

import unittest
import random
from itertools import combinations
from unittest.mock import patch

from classic_pikachu_bot import (
    PathIndex, Tile, choose_pair, find_pair, find_pairs, parse_state, plan_stage,
    simulate_move, wait_for_review,
)


def padded(*rows: tuple[int, ...]) -> tuple[tuple[int, ...], ...]:
    width = len(rows[0])
    edge = (0,) * (width + 2)
    return (edge, *((0, *row, 0) for row in rows), edge)


class PathSearchTests(unittest.TestCase):
    def test_adjacent_pair(self) -> None:
        board = padded((1, 1), (2, 3))
        self.assertEqual(find_pair(board), (Tile(1, 1), Tile(1, 2)))

    def test_path_around_blocker(self) -> None:
        board = padded((1, 2, 1), (3, 4, 5), (6, 7, 8))
        self.assertEqual(find_pair(board), (Tile(1, 1), Tile(1, 3)))

    def test_enclosed_pair_is_unreachable(self) -> None:
        board = padded(
            (2, 3, 4, 5, 6),
            (7, 8, 9, 10, 11),
            (12, 13, 1, 14, 15),
            (16, 17, 18, 19, 20),
            (21, 22, 1, 23, 24),
        )
        self.assertIsNone(find_pair(board))

    def test_page_cells_become_padded_board(self) -> None:
        state = parse_state({
            "rows": 2, "cols": 2,
            "cells": [{"row": 1, "col": 2, "kind": 5}],
            "level": 3, "shuffles": 8, "score": 120,
            "modal": "", "actions": [],
        })
        self.assertEqual(state.board, padded((0, 5), (0, 0)))
        self.assertEqual(state.remaining, 1)

    def test_paths_match_the_games_bounded_bfs(self) -> None:
        """Compare against a direct translation of the site's checkPath loop."""
        def game_connect(board, first, second):
            if board[first.row][first.col] != board[second.row][second.col]:
                return False
            cols, rows = len(board[0]), len(board)
            directions = ((0, 1), (0, -1), (1, 0), (-1, 0))  # (column, row)
            queue = [(first.col, first.row)]
            visited = {(first.col, first.row)}
            turns = {(first.col, first.row): 0}
            head = 0
            while head < len(queue):
                col, row = queue[head]
                head += 1
                active = [True] * 4
                p, q = [col] * 4, [row] * 4
                while any(active):
                    for direction, (dc, dr) in enumerate(directions):
                        if not active[direction]:
                            continue
                        p[direction] += dc
                        q[direction] += dr
                        x, y = p[direction], q[direction]
                        if not (0 <= x < cols and 0 <= y < rows):
                            active[direction] = False
                            continue
                        if (x, y) == (second.col, second.row):
                            return True
                        if board[y][x]:
                            active[direction] = False
                            continue
                        if (x, y) in visited or turns[(col, row)] == 2:
                            continue
                        queue.append((x, y))
                        visited.add((x, y))
                        turns[(x, y)] = turns[(col, row)] + 1
            return False

        rng = random.Random(41)
        for _ in range(40):
            values = [kind for kind in range(1, 10) for _ in range(4)]
            rng.shuffle(values)
            for index in rng.sample(range(36), 12):
                values[index] = 0
            board = padded(*(tuple(values[row * 6:(row + 1) * 6]) for row in range(6)))
            paths = PathIndex(board)
            by_kind = {}
            for row in range(1, 7):
                for col in range(1, 7):
                    if board[row][col]:
                        by_kind.setdefault(board[row][col], []).append(Tile(row, col))
            for tiles in by_kind.values():
                for first, second in combinations(tiles, 2):
                    self.assertEqual(paths.connected(first, second), game_connect(board, first, second))


class StageStrategyTests(unittest.TestCase):
    def test_single_direction_falls(self) -> None:
        board = padded(
            (1, 0, 0, 0),
            (2, 0, 0, 0),
            (1, 0, 0, 0),
            (3, 0, 0, 0),
        )
        pair = (Tile(1, 1), Tile(3, 1))
        self.assertEqual(simulate_move(board, 2, pair), padded(
            (0, 0, 0, 0), (0, 0, 0, 0), (2, 0, 0, 0), (3, 0, 0, 0)))
        self.assertEqual(simulate_move(board, 3, pair), padded(
            (2, 0, 0, 0), (3, 0, 0, 0), (0, 0, 0, 0), (0, 0, 0, 0)))
        self.assertEqual(simulate_move(board, 5, pair), padded(
            (0, 0, 0, 0), (0, 0, 0, 2), (0, 0, 0, 0), (0, 0, 0, 3)))

    def test_split_stage_boundary_behavior(self) -> None:
        board = padded(
            (0, 1, 0, 0),
            (7, 0, 0, 0),
            (0, 0, 0, 0),
            (0, 1, 0, 0),
        )
        pair = (Tile(1, 2), Tile(4, 2))
        self.assertEqual(simulate_move(board, 6, pair)[4][1], 7)
        self.assertEqual(simulate_move(board, 7, pair)[2][1], 7)

    def test_choice_keeps_a_follow_up_when_possible(self) -> None:
        board = padded(
            (1, 1, 2, 2),
            (3, 4, 4, 3),
            (5, 6, 6, 5),
            (7, 7, 8, 8),
        )
        pair = choose_pair(board, 2)
        self.assertIn(pair, find_pairs(board))
        self.assertTrue(find_pairs(simulate_move(board, 2, pair)))

    def test_planner_finds_complete_stage_without_shuffle(self) -> None:
        board = padded(
            (1, 1, 2, 2),
            (3, 3, 4, 4),
            (5, 5, 6, 6),
            (7, 7, 8, 8),
        )
        plan = plan_stage(board, 2, beam_width=8, node_budget=1000)
        self.assertEqual(len(plan), 8)
        for pair in plan:
            self.assertIn(pair, find_pairs(board))
            board = simulate_move(board, 2, pair)
        self.assertEqual(sum(value != 0 for row in board for value in row), 0)

    def test_planner_returns_a_legal_move_when_budget_expires(self) -> None:
        board = padded(
            (1, 1, 2, 2),
            (3, 3, 4, 4),
            (5, 5, 6, 6),
            (7, 7, 8, 8),
        )
        plan = plan_stage(board, 2, time_budget=1e-9)
        self.assertEqual(len(plan), 1)
        self.assertIn(plan[0], find_pairs(board))


class ReviewPauseTests(unittest.TestCase):
    def test_waits_until_browser_window_is_closed(self) -> None:
        class FakeDriver:
            checks = 0

            @property
            def window_handles(self) -> list[str]:
                self.checks += 1
                return ["open"] if self.checks == 1 else []

        driver = FakeDriver()
        with patch("classic_pikachu_bot.time.sleep") as sleep:
            wait_for_review(driver, enabled=True)
        self.assertEqual(driver.checks, 2)
        sleep.assert_called_once_with(1)

    def test_headless_review_returns_immediately(self) -> None:
        class FakeDriver:
            @property
            def window_handles(self) -> list[str]:
                raise AssertionError("Headless mode should not poll the browser")

        wait_for_review(FakeDriver(), enabled=False)


if __name__ == "__main__":
    unittest.main()
