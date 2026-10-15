// Not rendered by NORG: a verified agent gets this stripped, so it needs
// more than the strip's 120-word floor of visible text.
const words = Array.from({ length: 200 }, (_, i) => `fact${i}`).join(' ')

export default function Fresh() {
  return (
    <main>
      <nav>menu</nav>
      <h1>Fresh origin page</h1>
      <p>{words}</p>
    </main>
  )
}
