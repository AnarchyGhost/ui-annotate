<script setup>
const members = [
  { name: "Jordan Diaz", email: "jordan@northwind.dev", role: "Owner", seats: "Paid" },
  { name: "Priya Shah", email: "priya@northwind.dev", role: "Admin", seats: "Paid" },
  { name: "Leo Martin", email: "leo@northwind.dev", role: "Developer", seats: "Paid" },
  { name: "Mia Chen", email: "mia@northwind.dev", role: "Viewer", seats: "Free" },
];
</script>

<template>
  <section class="card team">
    <div class="card-head">
      <h2>Seats</h2>
      <button class="btn btn-primary" data-testid="invite">Invite</button>
    </div>
    <table>
      <thead>
        <tr><th>Name</th><th>Role</th><th>Seat</th></tr>
      </thead>
      <tbody>
        <tr v-for="member in members" :key="member.email">
          <td>
            <strong>{{ member.name }}</strong>
            <small>{{ member.email }}</small>
          </td>
          <td>{{ member.role }}</td>
          <td><span class="pill" :class="member.seats.toLowerCase()">{{ member.seats }}</span></td>
        </tr>
      </tbody>
    </table>
  </section>
</template>
