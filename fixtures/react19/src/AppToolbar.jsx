export default function AppToolbar() {
  const save = () => {};
  return (
    <header className="toolbar">
      <span className="toolbar__title">Fixture</span>
      <button data-testid="save" className="primary" onClick={save}>
        Save
      </button>
    </header>
  );
}
