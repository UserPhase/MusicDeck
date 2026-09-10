import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";

import {
  createUser,
  getUsers,
} from "../../api/musicdeck";
import { useAdminData } from "./useAdminData";
import { AdminPageHeader } from "../../components/admin/ui";


const EMPTY_USER = {
  username: "",
  password: "",
  displayName: "",
  role: "user",
};


function AdminUsers() {
  const navigate = useNavigate();

  const { data, setData, loading, saving, error, message, run } =
    useAdminData({ users: getUsers });

  const [search, setSearch] = useState("");
  const [roleFilter, setRoleFilter] = useState("all");
  const [newUser, setNewUser] = useState(EMPTY_USER);
  const [addOpen, setAddOpen] = useState(false);

  const users = useMemo(() => data.users || [], [data.users]);

  const visibleUsers = useMemo(() => {
    const query = search.trim().toLowerCase();

    return users.filter((user) => {
      if (roleFilter !== "all" && user.role !== roleFilter) {
        return false;
      }
      if (roleFilter === "disabled" && !user.disabled) {
        return false;
      }
      if (!query) {
        return true;
      }
      return (
        user.username.toLowerCase().includes(query) ||
        (user.displayName || "").toLowerCase().includes(query)
      );
    });
  }, [users, search, roleFilter]);

  async function handleCreateUser(event) {
    event.preventDefault();

    const user = await run(
      () =>
        createUser({
          username: newUser.username.trim(),
          password: newUser.password,
          displayName: newUser.displayName.trim() || undefined,
          role: newUser.role,
        }),
      { successMessage: "User created.", errorMessage: "Could not create user." }
    );

    if (user) {
      setData((current) => ({ ...current, users: [...current.users, user] }));
      setNewUser(EMPTY_USER);
      setAddOpen(false);
    }
  }

  if (loading) {
    return <div className="loading">Loading users...</div>;
  }

  return (
    <div className="admin-page">
      <AdminPageHeader
        title="Users"
        meta={`${users.length} account${users.length === 1 ? "" : "s"}`}
        actions={
          <button
            type="button"
            className="account-primary"
            onClick={() => setAddOpen((open) => !open)}
          >
            + Add user
          </button>
        }
      />

      {error && <div className="error">{error}</div>}
      {message && <div className="success">{message}</div>}

      {addOpen && (
        <section className="admin-section">
          <h2>Add user</h2>
          <form className="admin-form" onSubmit={handleCreateUser}>
            <label>
              <span>Username</span>
              <input
                value={newUser.username}
                onChange={(event) =>
                  setNewUser({ ...newUser, username: event.target.value })
                }
                required
              />
            </label>
            <label>
              <span>Display name</span>
              <input
                value={newUser.displayName}
                onChange={(event) =>
                  setNewUser({ ...newUser, displayName: event.target.value })
                }
              />
            </label>
            <label>
              <span>Password</span>
              <input
                type="password"
                value={newUser.password}
                onChange={(event) =>
                  setNewUser({ ...newUser, password: event.target.value })
                }
                minLength={8}
                required
              />
            </label>
            <label>
              <span>Role</span>
              <select
                aria-label="New user role"
                value={newUser.role}
                onChange={(event) =>
                  setNewUser({ ...newUser, role: event.target.value })
                }
              >
                <option value="user">user</option>
                <option value="admin">admin</option>
              </select>
            </label>
            <button type="submit" className="account-primary" disabled={saving}>
              Create user
            </button>
          </form>
        </section>
      )}

      <section className="admin-section">
        <div className="admin-toolbar">
          <input
            type="search"
            className="admin-search"
            placeholder="Search users..."
            aria-label="Search users"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <select
            aria-label="Filter users"
            className="admin-filter"
            value={roleFilter}
            onChange={(event) => setRoleFilter(event.target.value)}
          >
            <option value="all">All roles</option>
            <option value="admin">Admins</option>
            <option value="user">Users</option>
            <option value="disabled">Disabled</option>
          </select>
        </div>

        <div className="admin-table admin-users-table" role="table" aria-label="Users">
          <div className="admin-row admin-row-head" role="row">
            <span>Name</span>
            <span>Role</span>
            <span>Status</span>
            <span>Last active</span>
          </div>
          {visibleUsers.length === 0 ? (
            <div className="library-empty">No users match this filter.</div>
          ) : (
            visibleUsers.map((user) => (
              <button
                className="admin-row admin-user-row"
                key={user.id}
                type="button"
                role="row"
                onClick={() => navigate(`/admin/users/${user.id}`)}
              >
                <span><strong>{user.displayName || user.username}</strong><small>{user.username}</small></span>
                <span>{user.role === "admin" ? "Administrator" : "User"}</span>
                <span className={`admin-badge ${user.disabled ? "is-disabled" : "is-active"}`}>
                  {user.disabled ? "● Disabled" : "● Active"}
                </span>
                <span>Not available</span>
              </button>
            ))
          )}
        </div>
      </section>
    </div>
  );
}


export default AdminUsers;
