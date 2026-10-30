export interface WeatherCondition {
  text: string;
  icon: string;
}

export interface WeatherForecastDay {
  day: string;
  high: number;
  low: number;
  condition: WeatherCondition;
}

export interface WeatherOutput {
  location: string;
  temperature: number;
  temperatureHigh: number;
  temperatureLow: number;
  condition: WeatherCondition;
  humidity: number;
  windSpeed: number;
  dailyForecast: WeatherForecastDay[];
}
