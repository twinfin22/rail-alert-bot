import { expect, test } from "bun:test";
import { parseSrtSchedule } from "../src/srt/search";

test("normalizes SRT schedule rows into seat availability", () => {
  const html = `
    <table id="search-list"><tbody>
      <tr>
        <td><input type="hidden" name="trnNo[0]" value="000321"><input type="hidden" name="dptTm[0]" value="061000"><input type="hidden" name="runDt[0]" value="20990101"></td>
        <td>SRT 321</td>
        <td>06:10</td>
        <td>08:40</td>
        <td>Sold-out</td>
        <td>Reservation Available</td>
      </tr>
    </tbody></table>`;
  expect(parseSrtSchedule(html, "20990101")).toEqual([{
    trainNo: "321",
    date: "20990101",
    depTime: "061000",
    arrTime: "084000",
    generalAvailable: true,
    specialAvailable: false,
    generalState: "Reservation Available",
    specialState: "Sold-out",
  }]);
});
