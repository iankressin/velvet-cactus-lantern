import re

import pytest

from pipeline.cli import BadInput, main
from pipeline.cli.question import Question, SourceInput, load_question

USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"


def write_question(root, slug, text):
    folder = root / "answers" / slug
    folder.mkdir(parents=True)
    (folder / "question.yaml").write_text(text)


def test_reads_every_key(tmp_path):
    write_question(
        tmp_path,
        "eth-holders",
        """
question: How many wallets hold ETH?
asked: 2026-11-04
definitions:
  holder: A wallet with a balance above zero.
alternatives: [Count wallets with any asset]
window: {from: 2026-10-01, to: 2026-11-01}
inputs: [{wallets: addresses.json}]
marts: [latest_balances]
analyses: [eth_holders, eth_holders_by_day]
""",
    )
    question = load_question(tmp_path, "eth-holders")
    assert question.asked == "2026-11-04"
    assert question.definitions == {"holder": "A wallet with a balance above zero."}
    assert question.alternatives == ("Count wallets with any asset",)
    assert question.inputs == ({"wallets": "addresses.json"},)
    assert question.marts == ("latest_balances",)
    assert question.analyses == ("eth_holders", "eth_holders_by_day")


def test_analyses_default_to_the_slug_with_underscores(tmp_path):
    write_question(tmp_path, "eth-holders", "question: How many?\n")
    assert load_question(tmp_path, "eth-holders") == Question(
        slug="eth-holders",
        question="How many?",
        asked=None,
        definitions={},
        alternatives=(),
        window={},
        inputs=(),
        marts=(),
        analyses=("eth_holders",),
    )


def test_reads_the_block_range_and_the_inputs_that_name_a_source(tmp_path):
    write_question(
        tmp_path,
        "usdc-flows",
        f"""
question: How much USDC moved?
window: {{chain: ethereum, blocks: [26316189, 26340000]}}
inputs:
  - {{name: transfers, strategy: history, source: ethereum.erc20_transfers, filter: {{tokens: ["{USDC}"]}}}}
  - {{name: everything, source: ethereum.erc20_transfers}}
  - {{name: pools, strategy: history, filter: {{token: PEPE}}}}
""",
    )
    question = load_question(tmp_path, "usdc-flows")
    assert question.blocks == {"ethereum": (26316189, 26340000)}
    assert question.window == {"chain": "ethereum", "blocks": [26316189, 26340000]}
    assert question.sources == (
        SourceInput("ethereum.erc20_transfers", {"tokens": [USDC]}),
        SourceInput("ethereum.erc20_transfers", {}),
    )


def test_reads_a_block_range_for_each_chain(tmp_path):
    write_question(tmp_path, "q", "question: q\nwindow: {blocks: {ethereum: [26316189, 26340000], base: [53350927, 53394126]}}\n")
    assert load_question(tmp_path, "q").blocks == {"ethereum": (26316189, 26340000), "base": (53350927, 53394126)}


def test_one_block_range_needs_the_chain_it_is_on(tmp_path):
    write_question(tmp_path, "q", "question: q\nwindow: {blocks: [100, 200]}\n")
    with pytest.raises(BadInput, match=re.escape("'window.blocks' as [from, to] needs 'window.chain'")):
        load_question(tmp_path, "q")


def test_unknown_key_names_it_and_lists_the_allowed_keys(tmp_path):
    write_question(tmp_path, "q", "question: How many?\nanswer: 3\n")
    with pytest.raises(BadInput) as raised:
        load_question(tmp_path, "q")
    assert "unknown key 'answer'" in str(raised.value)
    assert "allowed keys: question, asked, definitions, alternatives, window, inputs, marts, analyses" in str(raised.value)


@pytest.mark.parametrize(
    "text, key",
    [
        ("question: 3\n", "question"),
        ("question: q\ndefinitions: [a, b]\n", "definitions"),
        ("question: q\ndefinitions: {a: 1}\n", "definitions"),
        ("question: q\nalternatives: one\n", "alternatives"),
        ("question: q\nwindow: [2026]\n", "window"),
        ("question: q\ninputs: [a]\n", "inputs"),
        ("question: q\nanalyses: []\n", "analyses"),
        ("question: q\nanalyses: [+upstream]\n", "analyses"),
        ("question: q\nasked: [2026]\n", "asked"),
    ],
)
def test_wrong_type_names_the_key(tmp_path, text, key):
    write_question(tmp_path, "q", text)
    with pytest.raises(BadInput, match=f"'{key}' must be"):
        load_question(tmp_path, "q")


@pytest.mark.parametrize(
    "text, key",
    [
        ("window: {blocks: [200, 100]}\n", "window.blocks"),
        ("window: {blocks: [100]}\n", "window.blocks"),
        ("window: {blocks: [100, latest]}\n", "window.blocks"),
        ("window: {blocks: [true, 2]}\n", "window.blocks"),
        ("window: {blocks: [-1, 2]}\n", "window.blocks"),
        ("window: {blocks: {ethereum: [200, 100]}}\n", "window.blocks"),
        ("window: {blocks: {ethereum: 100}}\n", "window.blocks"),
        ("window: {blocks: {Ethereum: [100, 200]}}\n", "window.blocks"),
        ("window: {blocks: {}}\n", "window.blocks"),
        ("window: {chain: [ethereum], blocks: [100, 200]}\n", "window.chain"),
        ("inputs: [{source: erc20_transfers}]\n", "inputs[0].source"),
        ("inputs: [{name: a}, {source: 3}]\n", "inputs[1].source"),
        (f'inputs: [{{source: ethereum.erc20_transfers, filter: {{tokens: "{USDC}"}}}}]\n', "inputs[0].filter"),
        ("inputs: [{source: ethereum.erc20_transfers, filter: [a]}]\n", "inputs[0].filter"),
    ],
)
def test_a_wrong_block_range_or_source_input_names_the_key(tmp_path, text, key):
    write_question(tmp_path, "q", "question: q\n" + text)
    with pytest.raises(BadInput, match=re.escape(f"'{key}' must")):
        load_question(tmp_path, "q")


def test_an_unquoted_address_in_a_filter_says_to_quote_it(tmp_path):
    write_question(tmp_path, "q", f"question: q\ninputs: [{{source: ethereum.erc20_transfers, filter: {{tokens: [{USDC}]}}}}]\n")
    with pytest.raises(BadInput, match=re.escape("YAML reads an unquoted 0x... as a number")):
        load_question(tmp_path, "q")


def test_question_is_required(tmp_path):
    write_question(tmp_path, "q", "asked: 2026-11-04\n")
    with pytest.raises(BadInput, match="'question' is required"):
        load_question(tmp_path, "q")


def test_missing_folder_or_file(tmp_path):
    with pytest.raises(BadInput, match="answers/q/ does not exist"):
        load_question(tmp_path, "q")
    (tmp_path / "answers" / "q").mkdir(parents=True)
    with pytest.raises(BadInput, match="question.yaml does not exist"):
        load_question(tmp_path, "q")


def test_bad_slug_exits_2_with_one_line(capsys):
    assert main(["answer", "../etc"]) == 2
    err = capsys.readouterr().err
    assert "slug '../etc' must match" in err
    assert err.count("\n") == 1
