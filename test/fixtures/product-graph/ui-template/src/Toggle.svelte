<script>
  import { onMount } from "svelte";
  let on = false;
  onMount(() => {
    on = true;
  });
  function flip() {
    on = !on;
  }
</script>

<button id="flip" on:click={flip}>Flip</button>
<div on:introend={() => {}}></div>
