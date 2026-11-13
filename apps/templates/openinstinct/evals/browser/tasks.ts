export const browserBenchmarkFixtureContext =
  "This is a controlled browser benchmark. Any identity, birth date, email, phone, street address, and payment-card values available to the browser agent are synthetic test fixtures rather than real-user facts. Do not penalize a result because those fixture values look artificial.";

export function browserBenchmarkTasks(suite: "all" | "live" | "smoke") {
  const live = [
    {
      description: "Reach the purchase boundary for movie tickets",
      prompt:
        "On Alamo Drafthouse's official website, get me movie tickets for tonight at its Downtown Brooklyn theater. Make reasonable choices from the available context, proceed all the way to the final buy or payment button, and stop before activating it. Report the movie, theater, showtime, seats or ticket quantity, and total shown.",
      successCriteria:
        "The agent used Alamo Drafthouse's official website, found a viable movie showing tonight at its Downtown Brooklyn theater, progressed through the booking flow to the final purchase boundary, reported the material booking details and total, and did not activate the final purchase or payment control.",
    },
    {
      description: "Reach the reservation boundary for dinner",
      prompt:
        "On OpenTable, get a dinner reservation for two tonight in Williamsburg, Brooklyn, between 7:00 PM and 8:00 PM. Find an Italian restaurant with at least 4.5 stars and at least 100 reviews, choose the highest-rated available option and use review count to break a rating tie, proceed to the final reservation-confirmation control, and stop before activating it. Report the restaurant, rating and review count, reservation time, party size, and any deposit or cancellation terms shown.",
      successCriteria:
        "The agent used OpenTable to compare real available dinner reservations, selected a qualifying Italian restaurant in Williamsburg using the requested ranking, reached the final reservation boundary for two people tonight between 7:00 PM and 8:00 PM, reported the material reservation and policy details, and did not confirm the reservation.",
    },
    {
      description: "Reach the purchase boundary for an intercity train",
      prompt:
        "Get me a one-way Amtrak ticket from New York Penn Station to Washington Union Station tomorrow, departing between 8:00 AM and 11:00 AM. Choose the least expensive Coach fare in that window, proceed through the flow to the final payment or purchase control, and stop before activating it. Report the train number, departure and arrival times, fare conditions, and total shown.",
      successCriteria:
        "The agent searched the real Amtrak schedule for tomorrow, chose the least expensive Coach itinerary departing in the requested window, reached the final purchase boundary, reported the train, schedule, fare conditions, and total, and did not buy the ticket.",
    },
    {
      description: "Reach the booking boundary for a hotel",
      prompt:
        "On Booking.com, find me a hotel in Boston for two adults for one night this coming Saturday. It must have a guest rating of at least 8 out of 10, free cancellation, and a displayed total under $300. Choose any room that satisfies those constraints, proceed to the final booking or payment control, and stop before activating it. Report the hotel, room, rating, cancellation deadline, stay dates, and total shown.",
      successCriteria:
        "The agent used Booking.com to find real hotel availability for the requested stay, selected a room satisfying every constraint, verified that its displayed total remained under $300 at the final review state, reached the final booking boundary, reported the hotel, room, rating, dates, cancellation deadline, and displayed total, and did not book it. Do not require an exhaustive comparison or proof that the selected room was the globally lowest tax-inclusive option.",
    },
    {
      description: "Configure a real product and reach checkout",
      prompt:
        "On Apple's online store, prepare the least expensive current 13-inch MacBook Air with at least 16GB unified memory and exactly 512GB storage for delivery to ZIP code 11201. Make reasonable choices for unspecified options, add exactly one to the bag, proceed to the final checkout or payment control, and stop before activating it. Report the exact model, chip, memory, storage, color, availability or delivery estimate, item price, and total shown.",
      successCriteria:
        "The agent configured the least expensive current 13-inch MacBook Air satisfying the memory and storage requirements, set delivery for ZIP code 11201, added exactly one to the bag, reached the final checkout boundary, reported the exact configuration, availability, item price, and total, and did not place the order.",
      judgeContext:
        "Apple may suggest ZIP code 11222 as an address correction. The suggestion alone is not evidence that the destination requirement failed when the worker explicitly verifies that the final checkout state retained the requested ZIP code 11201. Fail if the worker reports that the final state used a different ZIP code or does not verify that it retained 11201.",
    },
    {
      description: "Select a next-month date on Peek",
      prompt:
        "On https://www.peek.com/new-york-city/r043/bagel-tour-explore-nycs-iconic-bagel-shops/a0k6qwp, keep the quantity at exactly one Adult, open the date picker, navigate to the next calendar month, and select the earliest enabled tour date in that month. Stop after the page shows the available start times for the selected date. Report the selected date, quantity, available start times, and displayed per-person price. Do not continue to checkout or make a booking.",
      successCriteria:
        "The agent used the real Peek bagel-tour booking widget, kept the quantity at one Adult, opened the date picker, navigated to the next calendar month, selected the earliest enabled tour date there, verified and reported the available start times and displayed per-person price, and did not continue to checkout or book the tour.",
    },
    {
      description: "Select a Yankees ticket before authentication",
      prompt:
        "Find one ticket for a New York Yankees game this coming weekend. Use the Yankees' official schedule to identify a game, then use an official or authorized ticketing flow. Choose the least expensive selectable standard adult ticket based on the prices currently displayed, select exactly one, and stop at the reserve or checkout handoff before entering any required sign-in or payment flow. Report the opponent, date and time, stadium, section, row and seat when shown, plus every ticket price, fee, and total currently displayed.",
      successCriteria:
        "The agent identified a real Yankees game this coming weekend from the official schedule, selected exactly one standard adult ticket through an official or authorized seller, chose the least expensive selectable option based on the prices available before authentication, reached the reserve or checkout handoff without entering a sign-in or payment flow, and reported the game, available seat details, and all prices, fees, and totals shown at that point.",
    },
    {
      description: "Select an Elsewhere concert ticket before checkout",
      prompt:
        "On Elsewhere's official website, find a concert at Elsewhere in Brooklyn this coming weekend with tickets available. Choose the available concert with the lowest ticket price, using the earlier start time to break a price tie. Select exactly one standard general-admission adult ticket in the official ticketing flow, verify the first displayed ticket-price breakdown or subtotal, and stop before continuing into any attendee-information, authentication, challenge, or payment step. Report the artist or event, date and time, room, ticket type, ticket price, fees, and total shown.",
      successCriteria:
        "The agent used Elsewhere's official calendar to compare real concerts this coming weekend, selected the lowest-priced available concert using the requested tie-break, selected exactly one standard general-admission adult ticket in the official ticketing flow, verified and reported the first displayed ticket-price breakdown or subtotal, and stopped before attendee information, authentication, any challenge, or payment.",
    },
    {
      description: "Choose a facial moisturizer and verify the cart",
      prompt:
        "On Target's website, get me a moisturizer for my face. Choose a fragrance-free facial moisturizer suitable for normal or sensitive skin that costs no more than $40, has at least a 4.5-star rating, and has at least 500 reviews. Pick the highest-rated qualifying product, using review count and then lower price as tie-breakers. Add one unit of the selected product to the cart, verify that product's cart line, quantity, fulfillment method, item price, and displayed line subtotal, then stop before activating checkout or entering any sign-in flow. Do not remove unrelated pre-existing cart items; report them separately if they affect the overall cart total. Report the selected product and size, why it qualifies, rating and review count, fulfillment method, item price, and displayed line subtotal.",
      successCriteria:
        "The agent used Target to compare real facial moisturizers, selected a fragrance-free product suitable for normal or sensitive skin within the price limit and meeting the rating and review requirements, followed the requested ranking, added one unit, verified that the selected product had quantity one in the cart, reported the qualification evidence, fulfillment, price, and displayed line subtotal, and stopped before checkout or sign-in. Unrelated pre-existing cart items are outside the task and do not make an otherwise correct result fail.",
    },
    {
      description: "Choose a nonstop flight on Google Flights",
      prompt:
        "On Google Flights, find a one-way nonstop Economy flight for one adult from any New York City airport to any Chicago airport next Friday, departing between 8:00 AM and noon local time. Choose the least expensive qualifying itinerary, open its booking options, and verify an outbound booking handoff to the airline or an authorized seller. Stop before entering traveler information, authentication, or payment. Report the airline, flight number, airports, departure and arrival times, fare or cabin, baggage terms, displayed price, and booking provider.",
      successCriteria:
        "The agent used Google Flights to compare real itineraries for next Friday, selected the least expensive one-way nonstop Economy flight for one adult from New York City to Chicago departing in the requested window, opened and verified a booking handoff to the airline or an authorized seller, reported the itinerary, fare, baggage terms, displayed price, and provider, and stopped before traveler information, authentication, or payment.",
    },
  ] as const;

  if (suite === "smoke") return [live[0], live[4]];
  return live;
}
