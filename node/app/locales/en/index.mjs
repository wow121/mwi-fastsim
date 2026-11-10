// All English dictionaries, merged (one file per area so they can be edited independently).
import app from "./app.mjs"
import opt1 from "./opt1.mjs"
import opt2 from "./opt2.mjs"
import laby from "./laby.mjs"

export default Object.assign({}, laby, opt2, opt1, app)
