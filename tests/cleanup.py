"""Delete every test user (email starting with zz_test_), their books,
progress and files. run_tests.sh calls this after every run, even when a
suite fails or times out. Safe to run by hand at any time."""
import helpers

users, books = helpers.cleanup()
print(f"cleanup: deleted {users} test user(s) and the files of {books} test book(s)")
