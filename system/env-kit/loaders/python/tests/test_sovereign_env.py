from sovereign_env import is_secret_key, mask_value, parse_dotenv


def test_parse_dotenv_skips_comments_and_export():
    got = parse_dotenv("# c\nexport A=1\n\nB = two\nnoequals\n")
    assert got["A"] == "1"
    assert got["B"] == "two"
    assert "noequals" not in got


def test_secret_keys_are_detected_by_name_and_prefix():
    assert is_secret_key("GITHUB_TOKEN")
    assert is_secret_key("ANYTHING", "ghp_abc")
    assert not is_secret_key("CACHE_DIR")


def test_mask_value_never_returns_a_secret():
    assert mask_value("API_KEY", "abc123") == "SET [len=6]"
    assert mask_value("API_KEY", "") == "UNSET"
    assert mask_value("MODE", "dev") == "dev"
